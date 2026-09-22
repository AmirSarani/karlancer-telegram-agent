/**
 * Mandatory: mutation timeout → NEVER second automatic mutation POST.
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
  MessagePayloadSchema,
} from '../../src/api/contracts/verified-mutation.js';
import { z } from 'zod';

// Isolate from operator configs/verified-mutations.local.json on this machine
process.env.VERIFIED_MUTATION_CONFIG_PATH = path.join(os.tmpdir(), 'klr-no-mutations.json');

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'm.sqlite'));
}

/** Mock fetch that hangs until AbortSignal fires — simulates timeout after send. */
function hangingPostFetch(postCounter) {
  return async (url, init = {}) => {
    if (init.method === 'POST') {
      postCounter.n += 1;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ ok: true, status: 200, text: async () => '{}', headers: new Map() }), 30_000);
        if (init.signal) {
          if (init.signal.aborted) {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          init.signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({
        status: 'success',
        data: {
          has_submitted_bid: {},
          room: { id: 1, user_id: 42, guest_name: 't' },
          messages: { current_page: 1, last_page: 1, per_page: 20, total: 0, data: [] },
        },
      }), headers: new Map() };
  };
}

test('bid mutation timeout → needs_reconciliation and no second POST on retryOrDead', async () => {
  clearVerifiedMutationsForTests();
  registerVerifiedMutation({
    id: 'bid-t',
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
    fetchImpl: hangingPostFetch(posts),
  });

  const db = tmpDb();
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 9, proposalText: 'hello world proposal text', price: 1e7, days: 5 },
  });
  queue.decideApproval(queue.pendingApprovals()[0].approval_id, { approve: true, decidedBy: 't' });
  const claimed = queue.claim('w1');
  const out = await handleJob({ api, db, queue }, claimed);
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'needs_reconciliation');
  assert.equal(posts.n, 1);
  assert.equal(out.detail?.retryForbidden || out.detail?.status === 'unknown_side_effect', true);

  const again = queue.retryOrDead(job.jobId, { errorCode: 'unknown_side_effect' });
  assert.equal(again.status, 'needs_reconciliation');
  assert.equal(posts.n, 1, 'second mutation must never be sent');
  clearVerifiedMutationsForTests();
});

test('message mutation timeout → no second POST', async () => {
  clearVerifiedMutationsForTests();
  registerVerifiedMutation({
    id: 'msg-t',
    capability: 'messages.send',
    method: 'POST',
    pathTemplate: '/api/messages',
    payloadSchema: MessagePayloadSchema,
    expectedStatus: [200],
    responseSchema: z.any(),
    evidence: 'test',
    contractVersion: 't1',
  });

  const posts = { n: 0 };
  const api = createKarlancerApi({
    accessToken: 't',
    timeoutMs: 50,
    fetchImpl: hangingPostFetch(posts),
  });

  const db = tmpDb();
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'messages.send',
    requiresApproval: true,
    payload: { roomId: 1, text: 'salam', receptorId: 42 },
  });
  queue.decideApproval(queue.pendingApprovals()[0].approval_id, { approve: true, decidedBy: 't' });
  const claimed = queue.claim('w1');
  const out = await handleJob({ api, db, queue }, claimed);
  assert.equal(out.errorCode, 'needs_reconciliation');
  assert.equal(posts.n, 1);
  queue.retryOrDead(job.jobId, { errorCode: 'timeout' });
  assert.equal(posts.n, 1);
  clearVerifiedMutationsForTests();
});
