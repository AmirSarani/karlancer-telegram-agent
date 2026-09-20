/**
 * Durable job queue on SQLite with leases, heartbeat, idempotency, backoff+jitter.
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
  'dead_letter',
];

const RETRYABLE = new Set([
  'network',
  'timeout',
  'upstream_5xx',
  'rate_limited',
  'circuit_open',
  'retry',
  'handler_error',
  'exception',
]);

const NON_RETRYABLE = new Set([
  'missing_auth',
  'unauthorized',
  'unknown_goal',
  'blocked_by_missing_api',
  'needs_reconciliation',
  'unknown_side_effect',
  'validation',
  'rejected',
]);

export function hashApprovalPayload({
  tenantId,
  actor,
  action,
  payload,
  planVersion,
  targetRef,
  createdAt,
  expiresAt,
}) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        tenantId,
        actor,
        action,
        payload,
        planVersion,
        targetRef,
        createdAt,
        expiresAt,
      })
    )
    .digest('hex');
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createJobQueue(db) {
  return {
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
        operationId = null,
        targetRef = null,
        approvalTtlMs = 24 * 60 * 60 * 1000,
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
          attempt, created_at, updated_at, requires_approval, idempotency_key, payload_json,
          next_at, operation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?)`
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
        JSON.stringify(payload),
        operationId
      );

      appendEvent(db, {
        jobId,
        tenantId,
        type: 'job.created',
        actor: requestedBy,
        payload: { goal, status, requiresApproval },
      });

      if (requiresApproval) {
        const approvalId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + approvalTtlMs).toISOString();
        const resolvedTarget =
          targetRef != null
            ? String(targetRef)
            : payload.projectId != null
              ? String(payload.projectId)
              : payload.roomId != null
                ? String(payload.roomId)
                : null;
        const payloadHash = hashApprovalPayload({
          tenantId,
          actor: requestedBy,
          action: goal,
          payload,
          planVersion,
          targetRef: resolvedTarget,
          createdAt: now,
          expiresAt,
        });
        db.prepare(
          `INSERT INTO approvals (
            approval_id, job_id, action, status, payload_json, payload_hash, plan_version,
            tenant_id, actor, target_ref, expires_at, created_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          approvalId,
          jobId,
          goal,
          JSON.stringify(payload),
          payloadHash,
          planVersion,
          tenantId,
          requestedBy,
          resolvedTarget,
          expiresAt,
          now
        );
      }

      return this.get(jobId);
    },

    get(jobId) {
      const row = db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId);
      return row ? parseJob(row) : null;
    },

    list({ status = null, limit = 50, tenantId = null } = {}) {
      if (status && tenantId) {
        return db
          .prepare(
            `SELECT * FROM jobs WHERE status = ? AND tenant_id = ? ORDER BY priority ASC, created_at ASC LIMIT ?`
          )
          .all(status, tenantId, limit)
          .map(parseJob);
      }
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
     * Claim next due queued job with lease.
     * Jobs with next_at in the future are skipped.
     */
    claim(workerId, { leaseMs = 60_000 } = {}) {
      const now = new Date();
      const nowIso = now.toISOString();
      // Requeue ONLY expired leases without recent heartbeat (lease_until past)
      db.prepare(
        `UPDATE jobs SET status = 'queued', worker_id = NULL, lease_until = NULL, updated_at = ?
         WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`
      ).run(nowIso, nowIso);

      const job = db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'queued'
             AND (next_at IS NULL OR next_at <= ?)
           ORDER BY priority ASC, created_at ASC LIMIT 1`
        )
        .get(nowIso);
      if (!job) return null;

      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'running', worker_id = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?, next_at = NULL
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

    /**
     * Claim a specific job by id (for inline wait) — never steals another job.
     */
    claimById(jobId, workerId, { leaseMs = 60_000 } = {}) {
      const now = new Date();
      const nowIso = now.toISOString();
      const job = this.get(jobId);
      if (!job) return null;
      if (job.status !== 'queued') return null;
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'running', worker_id = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?, next_at = NULL
           WHERE job_id = ? AND status = 'queued'`
        )
        .run(workerId, leaseUntil, nowIso, jobId);
      if (info.changes === 0) return null;
      appendEvent(db, {
        jobId,
        type: 'job.claimed',
        actor: workerId,
        payload: { leaseUntil, byId: true },
      });
      return this.get(jobId);
    },

    heartbeat(jobId, workerId, { leaseMs = 60_000 } = {}) {
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      const nowIso = new Date().toISOString();
      const info = db
        .prepare(
          `UPDATE jobs SET lease_until = ?, updated_at = ? WHERE job_id = ? AND worker_id = ? AND status = 'running'`
        )
        .run(leaseUntil, nowIso, jobId, workerId);
      return info.changes > 0;
    },

    succeed(jobId, result = {}) {
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET status = 'succeeded', result_json = ?, result_ref = ?, lease_until = NULL, worker_id = NULL, updated_at = ?, error_code = NULL
         WHERE job_id = ?`
      ).run(JSON.stringify(result), result.ref || null, nowIso, jobId);
      appendEvent(db, { jobId, type: 'job.succeeded', payload: { ref: result.ref || null } });
      return this.get(jobId);
    },

    fail(jobId, errorCode, detail = {}) {
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET status = 'failed', error_code = ?, result_json = ?, lease_until = NULL, worker_id = NULL, updated_at = ?
         WHERE job_id = ?`
      ).run(errorCode, JSON.stringify(detail), nowIso, jobId);
      appendEvent(db, { jobId, type: 'job.failed', payload: { errorCode, ...sanitize(detail) } });
      return this.get(jobId);
    },

    setStatus(jobId, status, extra = {}) {
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET status = ?, error_code = COALESCE(?, error_code), result_json = COALESCE(?, result_json), updated_at = ?,
         lease_until = CASE WHEN ? IN ('queued','waiting_for_approval','succeeded','failed','cancelled','needs_reconciliation','dead_letter') THEN NULL ELSE lease_until END,
         worker_id = CASE WHEN ? IN ('queued','waiting_for_approval','succeeded','failed','cancelled','needs_reconciliation','dead_letter') THEN NULL ELSE worker_id END
         WHERE job_id = ?`
      ).run(
        status,
        extra.errorCode || null,
        extra.result ? JSON.stringify(extra.result) : null,
        nowIso,
        status,
        status,
        jobId
      );
      appendEvent(db, { jobId, type: 'job.status', payload: { status, errorCode: extra.errorCode || null } });
      return this.get(jobId);
    },

    cancel(jobId) {
      return this.setStatus(jobId, 'cancelled');
    },

    /**
     * Retry with exponential backoff + jitter. Mutations with unknown_side_effect are NEVER retried.
     */
    retryOrDead(jobId, { maxAttempts = 5, errorCode = 'retry', baseDelayMs = 1000 } = {}) {
      const job = this.get(jobId);
      if (!job) return null;

      if (NON_RETRYABLE.has(errorCode) || errorCode === 'unknown_side_effect') {
        return this.setStatus(jobId, 'needs_reconciliation', { errorCode, result: { retryForbidden: true } });
      }

      if (!RETRYABLE.has(errorCode) && job.attempt >= maxAttempts) {
        return this.fail(jobId, 'dead_letter', { lastError: errorCode, attempt: job.attempt });
      }

      if (job.attempt >= maxAttempts) {
        return this.fail(jobId, 'dead_letter', { lastError: errorCode, attempt: job.attempt });
      }

      const exp = Math.min(6, Math.max(0, job.attempt - 1));
      const delay = Math.floor(baseDelayMs * 2 ** exp + Math.random() * baseDelayMs);
      const nextAt = new Date(Date.now() + delay).toISOString();
      const nowIso = new Date().toISOString();
      db.prepare(
        `UPDATE jobs SET status = 'queued', worker_id = NULL, lease_until = NULL, next_at = ?, error_code = ?, updated_at = ?
         WHERE job_id = ?`
      ).run(nextAt, errorCode, nowIso, jobId);
      appendEvent(db, {
        jobId,
        type: 'job.retry_scheduled',
        payload: { nextAt, errorCode, attempt: job.attempt, delayMs: delay },
      });
      return this.get(jobId);
    },

    /**
     * Atomic approval decide — only pending + matching payload_hash (if provided).
     */
    decideApproval(approvalId, { approve, decidedBy, expectedPayloadHash = null }) {
      const row = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId);
      if (!row) return null;
      if (row.status !== 'pending') return { approval: row, job: this.get(row.job_id), alreadyDecided: true };

      if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
        db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ?, decided_by = ? WHERE approval_id = ? AND status = 'pending'`).run(
          new Date().toISOString(),
          decidedBy,
          approvalId
        );
        this.setStatus(row.job_id, 'cancelled', { errorCode: 'approval_expired' });
        return { approval: db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId), job: this.get(row.job_id), expired: true };
      }

      // Tamper check: recompute hash from stored payload vs stored hash; or expectedPayloadHash
      const job = this.get(row.job_id);
      if (row.payload_hash && job) {
        const recomputed = hashApprovalPayload({
          tenantId: row.tenant_id || job.tenantId,
          actor: row.actor || job.requestedBy,
          action: row.action,
          payload: row.payload_json ? JSON.parse(row.payload_json) : {},
          planVersion: row.plan_version || job.planVersion,
          targetRef: row.target_ref,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        });
        if (recomputed !== row.payload_hash) {
          return { approval: row, job, tampered: true, error: 'payload_hash_mismatch' };
        }
      }
      if (expectedPayloadHash && row.payload_hash && expectedPayloadHash !== row.payload_hash) {
        return { approval: row, job, tampered: true, error: 'expected_hash_mismatch' };
      }

      const nowIso = new Date().toISOString();
      const status = approve ? 'approved' : 'rejected';
      const info = db
        .prepare(
          `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE approval_id = ? AND status = 'pending'`
        )
        .run(status, nowIso, decidedBy, approvalId);
      if (info.changes === 0) {
        return { approval: db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId), job: this.get(row.job_id), alreadyDecided: true };
      }

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
      return {
        approval: db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId),
        job: this.get(row.job_id),
      };
    },

    pendingApprovals(tenantId = null) {
      if (tenantId) {
        return db
          .prepare(`SELECT * FROM approvals WHERE status = 'pending' AND tenant_id = ? ORDER BY created_at ASC`)
          .all(tenantId);
      }
      return db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`).all();
    },

    getApproval(approvalId) {
      return db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId);
    },

    getApprovalForJob(jobId) {
      return db
        .prepare(`SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(jobId);
    },
  };
}

function sanitize(detail) {
  if (!detail || typeof detail !== 'object') return {};
  const { message, errorCode, status, posted, retryForbidden } = detail;
  return { message, errorCode, status, posted, retryForbidden };
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
    operationId: row.operation_id,
    nextAt: row.next_at,
    payload: row.payload_json ? JSON.parse(row.payload_json) : {},
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

export default createJobQueue;
