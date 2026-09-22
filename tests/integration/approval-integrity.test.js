/**
 * Approval payload integrity: job/approval tamper, metadata change,
 * concurrent approve, crash/rollback atomicity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';

function tmpQueue() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-appr-')), 't.sqlite'));
  return { db, queue: createJobQueue(db) };
}

function makeApprovalJob(queue) {
  return queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 1, proposalText: 'hello world xx', price: 10, days: 3 },
    tenantId: 'tenant-a',
  });
}

test('tamper jobs.payload_json → payload_tampered, job never queued', () => {
  const { db, queue } = tmpQueue();
  const job = makeApprovalJob(queue);
  const appr = queue.getApprovalForJob(job.jobId);
  db.prepare(`UPDATE jobs SET payload_json = ? WHERE job_id = ?`).run(
    JSON.stringify({ projectId: 1, proposalText: 'TAMPERED JOB', price: 10, days: 3 }),
    job.jobId
  );
  const result = queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 't' });
  assert.equal(result.tampered, true);
  assert.equal(result.error, 'payload_tampered');
  assert.equal(queue.get(job.jobId).status, 'waiting_for_approval');
});

test('tamper approvals.payload_json → payload_tampered, job never queued', () => {
  const { db, queue } = tmpQueue();
  const job = makeApprovalJob(queue);
  const appr = queue.getApprovalForJob(job.jobId);
  db.prepare(`UPDATE approvals SET payload_json = ? WHERE approval_id = ?`).run(
    JSON.stringify({ projectId: 1, proposalText: 'TAMPERED APPR', price: 10, days: 3 }),
    appr.approval_id
  );
  const result = queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 't' });
  assert.equal(result.tampered, true);
  assert.equal(queue.get(job.jobId).status, 'waiting_for_approval');
});

test('change tenant/action/planVersion → payload_tampered', () => {
  const { db, queue } = tmpQueue();
  const job = makeApprovalJob(queue);
  const appr = queue.getApprovalForJob(job.jobId);

  db.prepare(`UPDATE jobs SET tenant_id = ? WHERE job_id = ?`).run('tenant-b', job.jobId);
  let result = queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 't' });
  assert.equal(result.tampered, true);

  db.prepare(`UPDATE jobs SET tenant_id = ?, goal = ? WHERE job_id = ?`).run('tenant-a', 'messages.send', job.jobId);
  result = queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 't' });
  assert.equal(result.tampered, true);

  db.prepare(`UPDATE jobs SET goal = ?, plan_version = ? WHERE job_id = ?`).run('bids.submit', '999', job.jobId);
  result = queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 't' });
  assert.equal(result.tampered, true);
  assert.equal(queue.get(job.jobId).status, 'waiting_for_approval');
});

test('concurrent approve: only one wins, job queued once', () => {
  const { queue } = tmpQueue();
  const job = makeApprovalJob(queue);
  const id = queue.getApprovalForJob(job.jobId).approval_id;
  const a = queue.decideApproval(id, { approve: true, decidedBy: 'a' });
  const b = queue.decideApproval(id, { approve: false, decidedBy: 'b' });
  assert.equal(a.approval.status, 'approved');
  assert.equal(b.alreadyDecided, true);
  assert.equal(b.approval.status, 'approved');
  assert.equal(queue.get(job.jobId).status, 'queued');
});

test('crash/rollback atomicity: thrown error inside txn leaves pending', () => {
  const { db, queue } = tmpQueue();
  const job = makeApprovalJob(queue);
  const id = queue.getApprovalForJob(job.jobId).approval_id;

  const original = queue.setStatus.bind(queue);
  let blown = false;
  queue.setStatus = (jobId, status, extra) => {
    if (!blown && status === 'queued') {
      blown = true;
      throw new Error('simulated_crash');
    }
    return original(jobId, status, extra);
  };

  assert.throws(() => queue.decideApproval(id, { approve: true, decidedBy: 't' }), /simulated_crash/);
  const appr = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(id);
  assert.equal(appr.status, 'pending');
  assert.equal(queue.get(job.jobId).status, 'waiting_for_approval');
});
