/**
 * P0: expired mutation leases → needs_reconciliation (never second POST).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { handleJob } from '../../src/worker/handlers.js';
import {
  registerVerifiedMutation,
  clearVerifiedMutationsForTests,
  BidPayloadSchema,
} from '../../src/api/contracts/verified-mutation.js';
import { z } from 'zod';

// Isolate from operator configs/verified-mutations.local.json on this machine
process.env.VERIFIED_MUTATION_CONFIG_PATH = path.join(os.tmpdir(), 'klr-no-mutations.json');

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-lease-')), 'm.sqlite'));
}

test('expired lease on bids.submit → needs_reconciliation; claim does not return it', () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 1, proposalText: 'hello world proposal text', price: 1e7, days: 5 },
  });
  queue.decideApproval(queue.pendingApprovals()[0].approval_id, { approve: true, decidedBy: 't' });
  const claimed = queue.claim('w1', { leaseMs: 1 });
  assert.equal(claimed.jobId, job.jobId);
  db.prepare(`UPDATE jobs SET lease_until = ? WHERE job_id = ?`).run(
    new Date(Date.now() - 10_000).toISOString(),
    job.jobId
  );
  const again = queue.claim('w2', { leaseMs: 60_000 });
  assert.equal(again, null);
  const row = queue.get(job.jobId);
  assert.equal(row.status, 'needs_reconciliation');
  assert.equal(row.errorCode, 'lease_expired_during_mutation');
});

test('crash-after-POST-before-commit: second POST never happens', async () => {
  clearVerifiedMutationsForTests();
  registerVerifiedMutation({
    id: 'bid-crash',
    capability: 'bids.submit',
    method: 'POST',
    pathTemplate: '/api/bids',
    payloadSchema: BidPayloadSchema,
    expectedStatus: [200],
    responseSchema: z.any(),
    evidence: 'test',
    contractVersion: 't1',
  });

  const posts = { n: 0 };
  const api = createKarlancerApi({
    accessToken: 't',
    timeoutMs: 50,
    fetchImpl: async (_url, init = {}) => {
      if ((init.method || 'GET').toUpperCase() === 'POST') {
        posts.n += 1;
        return { ok: true, status: 200, text: async () => '{}', headers: new Map() };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { has_submitted_bid: {} } }),
        headers: new Map(),
      };
    },
  });

  const db = tmpDb();
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 9, proposalText: 'hello world proposal text', price: 1e7, days: 5 },
  });
  queue.decideApproval(queue.pendingApprovals()[0].approval_id, { approve: true, decidedBy: 't' });
  const claimed = queue.claim('w1', { leaseMs: 60_000 });
  await handleJob({ api, db, queue }, claimed);
  assert.equal(posts.n, 1);

  db.prepare(
    `UPDATE jobs SET status = 'running', lease_until = ?, worker_id = 'dead', updated_at = ? WHERE job_id = ?`
  ).run(new Date(Date.now() - 5000).toISOString(), new Date().toISOString(), job.jobId);

  assert.equal(queue.claim('w2'), null);
  assert.equal(queue.get(job.jobId).status, 'needs_reconciliation');
  assert.equal(posts.n, 1);
  clearVerifiedMutationsForTests();
});

test('revalidateMutationBeforePost blocks POST on payload mismatch', async () => {
  clearVerifiedMutationsForTests();
  registerVerifiedMutation({
    id: 'bid-rv',
    capability: 'bids.submit',
    method: 'POST',
    pathTemplate: '/api/bids',
    payloadSchema: BidPayloadSchema,
    expectedStatus: [200],
    evidence: 'test',
    contractVersion: 't1',
  });
  const posts = { n: 0 };
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async (_u, init = {}) => {
      if ((init.method || '').toUpperCase() === 'POST') posts.n += 1;
      return { ok: true, status: 200, text: async () => '{}', headers: new Map() };
    },
  });
  const db = tmpDb();
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 1, proposalText: 'hello world proposal text', price: 1e7, days: 5 },
  });
  queue.decideApproval(queue.pendingApprovals()[0].approval_id, { approve: true, decidedBy: 't' });
  db.prepare(`UPDATE jobs SET payload_json = ? WHERE job_id = ?`).run(
    JSON.stringify({ projectId: 1, proposalText: 'TAMPERED proposal text here', price: 1e7, days: 5 }),
    job.jobId
  );
  const claimed = queue.claim('w1');
  const out = await handleJob({ api, db, queue }, claimed);
  assert.equal(out.ok, false);
  assert.equal(posts.n, 0);
  clearVerifiedMutationsForTests();
});
