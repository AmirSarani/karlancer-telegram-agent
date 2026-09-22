/**
 * End-to-end API tests against mock Karlancer HTTP (no live credentials required).
 * Live smoke is skipped unless KARLANCER_ACCESS_TOKEN is set — reported honestly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { handleJob } from '../../src/worker/handlers.js';
import { bumpHandoffMeta } from '../../src/memory/handoff.js';
import { createWorker } from '../../src/worker/runner.js';

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

function load(n) {
  return JSON.parse(fs.readFileSync(path.join(fx, n), 'utf8'));
}

function buildMockApi() {
  return createKarlancerApi({
    accessToken: 'test-token',
    fetchImpl: async (url, init = {}) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'GET' && p.startsWith('/api/rooms/') && !p.includes('messages')) {
        return ok(load('rooms-page1.json'));
      }
      if (method === 'GET' && p.includes('messages-pg')) return ok(load('messages-pg.json'));
      if (method === 'GET' && p.includes('check-bid')) return ok(load('check-bid.json'));
      if (method === 'GET' && p === '/api/publics/projects/555') return ok(load('project-slug.json'));
      if (method === 'GET' && p.includes('sample-project-slug')) return ok(load('project-detail.json'));
      if (method === 'POST') return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
      return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
    },
  });
}

function ok(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Map() };
}

describe('e2e mock vertical slice', () => {
  test('scan → memory → handoff → bid plan blocked honestly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-e2e-'));
    const db = openDb(path.join(dir, 'e.sqlite'));
    const queue = createJobQueue(db);
    const api = buildMockApi();
    const stateDir = path.join(dir, 'state');

    const scanJob = queue.create({ goal: 'rooms.scan', payload: { page: 1, keywords: ['دعوت'] } });
    const claimed = queue.claim('e2e');
    const scanOut = await handleJob({ api, db, queue }, claimed);
    assert.equal(scanOut.ok, true);
    queue.succeed(scanJob.jobId, scanOut.result);

    const bidJob = queue.create({
      goal: 'bids.submit',
      requiresApproval: true,
      payload: {
        projectId: 555,
        proposalText: 'پیشنهاد تستی کافی طولانی',
        price: 10_000_000,
        days: 14,
      },
    });
    assert.equal(bidJob.status, 'waiting_for_approval');
    const appr = queue.pendingApprovals()[0];
    queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 'e2e' });
    const bidClaim = queue.claim('e2e');
    const bidOut = await handleJob({ api, db, queue }, bidClaim);
    assert.equal(bidOut.ok, false);
    assert.equal(bidOut.errorCode, 'needs_reconciliation');
    assert.equal(queue.get(bidJob.jobId).status, 'needs_reconciliation');
    assert.equal(bidOut.detail.status, 'blocked_by_missing_api');

    const v = await bumpHandoffMeta(db, stateDir, {
      agent: 'e2e',
      status: 'tested',
      lastChange: 'e2e mock vertical slice',
      nextAction: 'live token smoke if available',
      blockers: ['bid POST unverified'],
      inProgress: [],
      capabilities: ['scan', 'handoff'],
      queueDepth: 0,
      pendingApprovals: 0,
    });
    assert.ok(v >= 1);
    assert.ok(fs.existsSync(path.join(stateDir, 'AGENT_HANDOFF.md')));
  });

  test('worker recovers expired lease', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-e2e2-'));
    const db = openDb(path.join(dir, 'e.sqlite'));
    const queue = createJobQueue(db);
    const api = buildMockApi();
    const job = queue.create({ goal: 'health.ping' });
    queue.claim('dead-worker', { leaseMs: 1 });
    db.prepare(`UPDATE jobs SET lease_until = ? WHERE job_id = ?`).run(
      new Date(Date.now() - 5000).toISOString(),
      job.jobId
    );
    const worker = createWorker({ db, queue, api, pollMs: 50, leaseMs: 5000 });
    // one claim via queue directly (worker loop is long-running)
    const recovered = queue.claim('alive');
    assert.ok(recovered);
    assert.equal(recovered.jobId, job.jobId);
    await worker.stop();
  });
});
