import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { handleJob } from '../../src/worker/handlers.js';
import { clearVerifiedMutationsForTests, bidIdempotencyKey } from '../../src/api/contracts/verified-mutation.js';

function mockFetch(handler) {
  return async (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '');
    const hit = handler(p);
    if (!hit) {
      return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(hit), headers: new Map() };
  };
}

test('health.ping handler', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w.sqlite'));
  const queue = createJobQueue(db);
  const api = createKarlancerApi({ accessToken: 't', fetchImpl: mockFetch(() => ({})) });
  const job = queue.create({ goal: 'health.ping' });
  const out = await handleJob({ api, db, queue }, job);
  assert.equal(out.ok, true);
  assert.equal(out.result.pong, true);
});

test('rooms.scan with fixtures', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w2.sqlite'));
  const queue = createJobQueue(db);
  const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
  const rooms = JSON.parse(fs.readFileSync(path.join(fx, 'rooms-page1.json'), 'utf8'));
  const msgs = JSON.parse(fs.readFileSync(path.join(fx, 'messages-pg.json'), 'utf8'));
  const bid = JSON.parse(fs.readFileSync(path.join(fx, 'check-bid.json'), 'utf8'));
  const slug = JSON.parse(fs.readFileSync(path.join(fx, 'project-slug.json'), 'utf8'));
  const detail = JSON.parse(fs.readFileSync(path.join(fx, 'project-detail.json'), 'utf8'));

  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.includes('messages-pg')) return msgs;
      if (p.includes('check-bid')) return bid;
      if (p.includes('sample-project-slug')) return detail;
      if (/\/api\/publics\/projects\/555\/?$/.test(p) || p === '/api/publics/projects/555') return slug;
      if (/\/api\/rooms\/\?page=/.test(p) || p.startsWith('/api/rooms/?')) return rooms;
      return null;
    }),
  });
  const job = queue.create({ goal: 'rooms.scan', payload: { page: 1, keywords: ['دعوت'] } });
  const out = await handleJob({ api, db, queue }, job);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.result.matchedCount >= 1, JSON.stringify(out.result));
});

test('bids.submit without contract → needs_reconciliation, no POST', async () => {
  clearVerifiedMutationsForTests();
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w3.sqlite'));
  const queue = createJobQueue(db);
  let posts = 0;
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') posts += 1;
      return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
    },
  });
  const job = queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 1, proposalText: 'hello world proposal', price: 1, days: 7 },
  });
  queue.decideApproval(queue.pendingApprovals()[0].approval_id, { approve: true, decidedBy: 't' });
  const claimed = queue.claim('w');
  const out = await handleJob({ api, db, queue }, claimed);
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'needs_reconciliation');
  assert.equal(queue.get(job.jobId).status, 'needs_reconciliation');
  assert.equal(posts, 0);
});

test('claimById does not steal other queued jobs (wait=true bugfix)', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w4.sqlite'));
  const queue = createJobQueue(db);
  const other = queue.create({ goal: 'health.ping', priority: 1 });
  const target = queue.create({ goal: 'rooms.scan', payload: { page: 1 }, priority: 100 });
  const claimed = queue.claimById(target.jobId, 'mcp-inline');
  assert.equal(claimed.jobId, target.jobId);
  assert.equal(queue.get(other.jobId).status, 'queued');
});

test('two workers cannot both own same running job after claim', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w5.sqlite'));
  const queue = createJobQueue(db);
  queue.create({ goal: 'health.ping' });
  const a = queue.claim('worker-a');
  const b = queue.claim('worker-b');
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(a.workerId, 'worker-a');
});

test('heartbeat extends lease so reclaim does not steal active job', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w6.sqlite'));
  const queue = createJobQueue(db);
  queue.create({ goal: 'health.ping' });
  const job = queue.claim('w1', { leaseMs: 80 });
  assert.ok(job);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(queue.heartbeat(job.jobId, 'w1', { leaseMs: 200 }), true);
  await new Promise((r) => setTimeout(r, 100));
  const stolen = queue.claim('w2', { leaseMs: 80 });
  assert.equal(stolen, null, 'active heartbeating job must not be reclaimed');
});

test('idempotency key includes full bid payload', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w7.sqlite'));
  const queue = createJobQueue(db);
  const k1 = bidIdempotencyKey({ projectId: 1, proposalText: 'a', price: 1, days: 1 });
  const k2 = bidIdempotencyKey({ projectId: 1, proposalText: 'a', price: 2, days: 1 });
  assert.notEqual(k1, k2);
  const j1 = queue.create({ goal: 'bids.submit', idempotencyKey: k1, payload: { projectId: 1 }, requiresApproval: true });
  const j2 = queue.create({ goal: 'bids.submit', idempotencyKey: k1, payload: { projectId: 1 }, requiresApproval: true });
  assert.equal(j1.jobId, j2.jobId);
});

test('approval payload tamper detected', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w8.sqlite'));
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 1, proposalText: 'hello world xx', price: 1, days: 1 },
  });
  const appr = queue.getApprovalForJob(job.jobId);
  db.prepare(`UPDATE approvals SET payload_json = ? WHERE approval_id = ?`).run(
    JSON.stringify({ projectId: 1, proposalText: 'TAMPERED', price: 1, days: 1 }),
    appr.approval_id
  );
  const result = queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 't' });
  assert.equal(result.tampered, true);
});

test('duplicate approval decide is atomic', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w9.sqlite'));
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'bids.submit',
    requiresApproval: true,
    payload: { projectId: 1, proposalText: 'hello world xx', price: 1, days: 1 },
  });
  const id = queue.getApprovalForJob(job.jobId).approval_id;
  const a = queue.decideApproval(id, { approve: true, decidedBy: 'a' });
  const b = queue.decideApproval(id, { approve: false, decidedBy: 'b' });
  assert.equal(a.approval.status, 'approved');
  assert.equal(b.alreadyDecided, true);
  assert.equal(b.approval.status, 'approved');
});
