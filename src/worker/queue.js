/**
 * Durable job queue on SQLite with leases, idempotency, backoff.
 */
import crypto from 'node:crypto';
import { appendEvent } from '../memory/events.js';

export const JOB_STATUSES = [
  'queued',
  'planning',
  'waiting_for_approval',
  'running',
  'waiting_external',
  'succeeded',
  'failed',
  'cancelled',
  'needs_reconciliation',
];

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createJobQueue(db) {
  return {
    /**
     * @param {object} input
     */
    create(input) {
      const {
        tenantId = 'default',
        requestedBy = 'system',
        goal,
        payload = {},
        priority = 100,
        requiresApproval = false,
        idempotencyKey = null,
        planVersion = '1',
      } = input;

      if (idempotencyKey) {
        const existing = db
          .prepare(`SELECT * FROM jobs WHERE tenant_id = ? AND idempotency_key = ?`)
          .get(tenantId, idempotencyKey);
        if (existing) return parseJob(existing);
      }

      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();
      const status = requiresApproval ? 'waiting_for_approval' : 'queued';
      db.prepare(
        `INSERT INTO jobs (
          job_id, tenant_id, requested_by, goal, plan_version, status, priority,
          attempt, created_at, updated_at, requires_approval, idempotency_key, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        tenantId,
        requestedBy,
        goal,
        planVersion,
        status,
        priority,
        now,
        now,
        requiresApproval ? 1 : 0,
        idempotencyKey,
        JSON.stringify(payload)
      );

      appendEvent(db, {
        jobId,
        tenantId,
        type: 'job.created',
        actor: requestedBy,
        payload: { goal, status, requiresApproval },
      });

      // Create approval row if needed
      if (requiresApproval) {
        const approvalId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO approvals (approval_id, job_id, action, status, payload_json, created_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`
        ).run(approvalId, jobId, goal, JSON.stringify(payload), now);
      }

      return this.get(jobId);
    },

    get(jobId) {
      const row = db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId);
      return row ? parseJob(row) : null;
    },

    list({ status = null, limit = 50 } = {}) {
      if (status) {
        return db
          .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY priority ASC, created_at ASC LIMIT ?`)
          .all(status, limit)
          .map(parseJob);
      }
      return db
        .prepare(`SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?`)
        .all(limit)
        .map(parseJob);
    },

    /**
     * Claim next queued job with lease.
     */
    claim(workerId, { leaseMs = 60_000 } = {}) {
      const now = new Date();
      const nowIso = now.toISOString();
      // Requeue expired leases
      db.prepare(
        `UPDATE jobs SET status = 'queued', worker_id = NULL, lease_until = NULL, updated_at = ?
         WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`
      ).run(nowIso, nowIso);

      const job = db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 1`
        )
        .get();
      if (!job) return null;

      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'running', worker_id = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?
           WHERE job_id = ? AND status = 'queued'`
        )
        .run(workerId, leaseUntil, nowIso, job.job_id);
      if (info.changes === 0) return null;

      appendEvent(db, {
        jobId: job.job_id,
        type: 'job.claimed',
        actor: workerId,
        payload: { leaseUntil, attempt: job.attempt + 1 },
      });
      return this.get(job.job_id);
    },

    heartbeat(jobId, workerId, { leaseMs = 60_000 } = {}) {
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET lease_until = ?, updated_at = ? WHERE job_id = ? AND worker_id = ? AND status = 'running'`
      ).run(leaseUntil, nowIso, jobId, workerId);
    },

    succeed(jobId, result = {}) {
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET status = 'succeeded', result_json = ?, result_ref = ?, lease_until = NULL, updated_at = ?, error_code = NULL
         WHERE job_id = ?`
      ).run(JSON.stringify(result), result.ref || null, nowIso, jobId);
      appendEvent(db, { jobId, type: 'job.succeeded', payload: { ref: result.ref || null } });
      return this.get(jobId);
    },

    fail(jobId, errorCode, detail = {}) {
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET status = 'failed', error_code = ?, result_json = ?, lease_until = NULL, updated_at = ?
         WHERE job_id = ?`
      ).run(errorCode, JSON.stringify(detail), nowIso, jobId);
      appendEvent(db, { jobId, type: 'job.failed', payload: { errorCode, ...detail } });
      return this.get(jobId);
    },

    setStatus(jobId, status, extra = {}) {
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET status = ?, error_code = COALESCE(?, error_code), result_json = COALESCE(?, result_json), updated_at = ?,
         lease_until = CASE WHEN ? IN ('queued','waiting_for_approval','succeeded','failed','cancelled') THEN NULL ELSE lease_until END
         WHERE job_id = ?`
      ).run(
        status,
        extra.errorCode || null,
        extra.result ? JSON.stringify(extra.result) : null,
        nowIso,
        status,
        jobId
      );
      appendEvent(db, { jobId, type: 'job.status', payload: { status, ...extra } });
      return this.get(jobId);
    },

    cancel(jobId) {
      return this.setStatus(jobId, 'cancelled');
    },

    /**
     * Requeue for retry with attempt limit → dead letter via failed.
     */
    retryOrDead(jobId, { maxAttempts = 5, errorCode = 'retry' } = {}) {
      const job = this.get(jobId);
      if (!job) return null;
      if (job.attempt >= maxAttempts) {
        return this.fail(jobId, 'dead_letter', { lastError: errorCode, attempt: job.attempt });
      }
      // exponential backoff encoded as delayed lease in waiting_external then queued — simple: back to queued
      return this.setStatus(jobId, 'queued', { errorCode });
    },

    decideApproval(approvalId, { approve, decidedBy }) {
      const row = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId);
      if (!row) return null;
      if (row.status !== 'pending') return { approval: row, job: this.get(row.job_id) };
      const nowIso = new Date().toISOString();
      const status = approve ? 'approved' : 'rejected';
      db.prepare(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE approval_id = ?`
      ).run(status, nowIso, decidedBy, approvalId);

      if (approve) {
        this.setStatus(row.job_id, 'queued');
      } else {
        this.setStatus(row.job_id, 'cancelled', { errorCode: 'rejected' });
      }
      appendEvent(db, {
        jobId: row.job_id,
        type: approve ? 'approval.granted' : 'approval.rejected',
        actor: decidedBy,
        payload: { approvalId },
      });
      return { approval: db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId), job: this.get(row.job_id) };
    },

    pendingApprovals() {
      return db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`).all();
    },

    getApprovalForJob(jobId) {
      return db
        .prepare(`SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(jobId);
    },
  };
}

function parseJob(row) {
  return {
    jobId: row.job_id,
    tenantId: row.tenant_id,
    requestedBy: row.requested_by,
    goal: row.goal,
    planVersion: row.plan_version,
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    leaseUntil: row.lease_until,
    workerId: row.worker_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventId: row.last_event_id,
    resultRef: row.result_ref,
    errorCode: row.error_code,
    requiresApproval: !!row.requires_approval,
    idempotencyKey: row.idempotency_key,
    payload: row.payload_json ? JSON.parse(row.payload_json) : {},
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

export default createJobQueue;
