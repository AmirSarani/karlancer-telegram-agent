import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { extractMessageList, normalizeMessage, getSendApiCandidates } from '../../src/api/adapters/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, '../fixtures');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
}

function mockFetch(router) {
  return async (url, init = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    const pathOnly = u.replace(/^https?:\/\/[^/]+/, '');
    const hit = router(pathOnly, init);
    if (!hit) {
      return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
    }
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      text: async () => JSON.stringify(hit.body),
      headers: new Map(),
    };
  };
}

test('rooms.list normalizes fixture', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.startsWith('/api/rooms/')) return { status: 200, body: load('rooms-page1.json') };
      return null;
    }),
  });
  const { rooms } = await api.rooms.list({ page: 1 });
  assert.equal(rooms.length, 2);
  assert.equal(rooms[0].id, '101');
  assert.match(rooms[0].lastMessage, /دعوت/);
});

test('messages.list extracts nested data', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.includes('messages-pg')) return { status: 200, body: load('messages-pg.json') };
      return null;
    }),
  });
  const data = await api.messages.list(101);
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[0].projectId, '555');
});

test('extractMessageList shapes', () => {
  assert.equal(extractMessageList(load('messages-pg.json')).length, 2);
  assert.equal(normalizeMessage({ id: 9, message: 'x' }).text, 'x');
});

test('bids.check map', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.startsWith('/api/check-bid')) return { status: 200, body: load('check-bid.json') };
      return null;
    }),
  });
  const c = await api.bids.check([555, 556]);
  assert.equal(c.weBidFor(555), false);
  assert.equal(c.weBidFor(556), true);
});

test('projects public', async () => {
  const api = createKarlancerApi({
    fetchImpl: mockFetch((p) => {
      if (p === '/api/publics/projects/555') return { status: 200, body: load('project-slug.json') };
      if (p.includes('sample-project-slug')) return { status: 200, body: load('project-detail.json') };
      return null;
    }),
  });
  const p = await api.projects.get(555);
  assert.equal(p.slug, 'sample-project-slug');
  assert.equal(p.project.title, 'نمونه پروژه');
});

test('send try-list marks blocked when all 404', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch(() => ({ status: 404, body: {} })),
  });
  const r = await api.messages.send(1, 'hello');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'blocked_by_missing_api');
  assert.ok(r.attempts.length > 0);
});

test('getSendApiCandidates matches extension', () => {
  const c = getSendApiCandidates(12, 'hi');
  assert.ok(c.some((x) => x.path === '/api/rooms/12/messages'));
  assert.ok(c.some((x) => x.path === '/api/messages'));
});

test('missing auth throws on protected route', async () => {
  const api = createKarlancerApi({ fetchImpl: mockFetch(() => ({ status: 200, body: {} })) });
  await assert.rejects(() => api.rooms.list(), /missing_auth|KARLANCER/);
});
