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

test('bids.submit without working endpoint → needs_reconciliation', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'w3.sqlite'));
  const queue = createJobQueue(db);
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '{}', headers: new Map() }),
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
});
