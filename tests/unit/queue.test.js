import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-'));
  return openDb(path.join(dir, 't.sqlite'));
}

test('idempotent job create', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'a.sqlite'));
  const q = createJobQueue(db);
  const a = q.create({ goal: 'health.ping', idempotencyKey: 'x1' });
  const b = q.create({ goal: 'health.ping', idempotencyKey: 'x1' });
  assert.equal(a.jobId, b.jobId);
});

test('claim lease and succeed', () => {
  const db = tmpDb();
  const q = createJobQueue(db);
  const job = q.create({ goal: 'health.ping' });
  const claimed = q.claim('w1');
  assert.equal(claimed.jobId, job.jobId);
  assert.equal(claimed.status, 'running');
  q.succeed(job.jobId, { pong: true });
  assert.equal(q.get(job.jobId).status, 'succeeded');
});

test('approval gate then approve', () => {
  const db = tmpDb();
  const q = createJobQueue(db);
  const job = q.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 1 },
  });
  assert.equal(job.status, 'waiting_for_approval');
  assert.equal(q.claim('w1'), null);
  const appr = q.pendingApprovals()[0];
  q.decideApproval(appr.approval_id, { approve: true, decidedBy: 'test' });
  assert.equal(q.get(job.jobId).status, 'queued');
});

test('expired lease requeued', () => {
  const db = tmpDb();
  const q = createJobQueue(db);
  const job = q.create({ goal: 'health.ping' });
  q.claim('w1', { leaseMs: 1 });
  // force expire
  db.prepare(`UPDATE jobs SET lease_until = ? WHERE job_id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    job.jobId
  );
  const again = q.claim('w2');
  assert.ok(again);
  assert.equal(again.jobId, job.jobId);
});
