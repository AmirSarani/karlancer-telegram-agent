import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import {
  clearVerifiedMutationsForTests,
  registerVerifiedMutation,
  BidPayloadSchema,
  MessagePayloadSchema,
} from '../../src/api/contracts/verified-mutation.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, '../fixtures');
const load = (n) => JSON.parse(fs.readFileSync(path.join(fixtures, n), 'utf8'));

function mockFetch(router) {
  return async (url, init = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    const pathOnly = u.replace(/^https?:\/\/[^/]+/, '');
    const hit = router(pathOnly, init);
    if (!hit) return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      text: async () => JSON.stringify(hit.body),
      headers: new Map(),
    };
  };
}

test('dashboard/user.me normalizes HAR fixture', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.startsWith('/api/dashboard')) return { status: 200, body: load('har-dashboard.json') };
      return null;
    }),
  });
  const me = await api.user.me();
  assert.equal(me.status === 'ok' || me.id != null || me.user != null, true);
});

test('notifications.list from HAR fixture', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.startsWith('/api/notifications')) return { status: 200, body: load('har-notifications.json') };
      return null;
    }),
  });
  const data = await api.notifications.list({ page: 1 });
  assert.ok(Array.isArray(data.notifications));
});

test('rooms.listArchived from HAR fixture', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.includes('/api/rooms/archive')) return { status: 200, body: load('har-rooms-archive.json') };
      return null;
    }),
  });
  const data = await api.rooms.listArchived({ page: 1 });
  assert.ok(Array.isArray(data.rooms));
  assert.ok(data.pagination);
});

test('projects.search from HAR fixture', async () => {
  const api = createKarlancerApi({
    fetchImpl: mockFetch((p) => {
      if (p.includes('/api/publics/search/projects') || p.includes('/api/publics/search/projects')) {
        return { status: 200, body: load('har-search-projects.json') };
      }
      return null;
    }),
  });
  const data = await api.projects.search({ order: 'latest' });
  assert.ok(Array.isArray(data.projects));
});

test('bookmarks.projectIds from HAR fixture', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: mockFetch((p) => {
      if (p.includes('/api/bookmarks/project/ids')) return { status: 200, body: load('har-bookmarks-project.json') };
      return null;
    }),
  });
  const data = await api.bookmarks.projectIds();
  assert.ok(Array.isArray(data.ids));
});

test('401 on rooms.list surfaces unauthorized', async () => {
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"Unauthenticated"}', headers: new Map() }),
  });
  await assert.rejects(() => api.rooms.list({ page: 1 }), /unauth|401|KARLANCER|auth/i);
});

test('HAR bid schema accepts milestone payload', () => {
  const body = load('har-bid-req.json');
  const parsed = BidPayloadSchema.parse(body);
  assert.ok(parsed.milestones.length >= 1);
});

test('HAR message schema accepts receptor/room payload', () => {
  const body = load('har-msg-req.json');
  const parsed = MessagePayloadSchema.parse(body);
  assert.equal(typeof parsed.message, 'string');
});

test('bids.submit with HAR contract posts milestone-shaped body once', async () => {
  clearVerifiedMutationsForTests();
  let posted;
  registerVerifiedMutation({
    id: 'test-bid-har',
    capability: 'bids.submit',
    method: 'POST',
    pathTemplate: '/api/bids',
    payloadSchema: BidPayloadSchema,
    expectedStatus: [200, 201],
    responseSchema: z.any(),
    evidence: 'unit-har',
    contractVersion: 'test-har-1',
  });
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') {
        posted = JSON.parse(init.body);
        return { ok: true, status: 201, text: async () => '{"status":"success"}', headers: new Map() };
      }
      return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
    },
  });
  const r = await api.bids.submit({ projectId: 42, proposalText: 'proposal text here', price: 2500000, days: 14 });
  assert.equal(r.ok, true);
  assert.equal(posted.project_id, 42);
  assert.ok(Array.isArray(posted.milestones));
  assert.equal(String(posted.milestones[0].budget), '2500000');
  clearVerifiedMutationsForTests();
});

test('messages.send with HAR contract requires receptor and posts shape', async () => {
  clearVerifiedMutationsForTests();
  let posted;
  registerVerifiedMutation({
    id: 'test-msg-har',
    capability: 'messages.send',
    method: 'POST',
    pathTemplate: '/api/messages',
    payloadSchema: MessagePayloadSchema,
    expectedStatus: [200, 201],
    responseSchema: z.any(),
    evidence: 'unit-har',
    contractVersion: 'test-har-1',
  });
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST') {
        posted = JSON.parse(init.body);
        return { ok: true, status: 201, text: async () => '{"status":"success"}', headers: new Map() };
      }
      // room list for receptor resolution fallback
      if (u.includes('messages-pg') || u.includes('messages-pg')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: 'success',
              data: {
                room: { id: 1, user_id: 99, guest_name: 'x' },
                messages: { data: [], current_page: 1, last_page: 1, per_page: 20, total: 0 },
              },
            }),
          headers: new Map(),
        };
      }
      return { ok: false, status: 404, text: async () => '{}', headers: new Map() };
    },
  });
  const r = await api.messages.send(1, 'hello', { receptorId: 99 });
  assert.equal(r.ok, true);
  assert.equal(Number(posted.receptor_id), 99);
  assert.equal(Number(posted.room_id), 1);
  assert.equal(posted.message, 'hello');
  clearVerifiedMutationsForTests();
});
