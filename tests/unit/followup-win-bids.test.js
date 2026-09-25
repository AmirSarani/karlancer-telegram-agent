/**
 * Item 5: website replies count as answered (24h follow-up). Item 6: win detection by our bid status.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createPermissionGate } from '../../src/telegram/permission-gate.js';
import { createMutationRequester } from '../../src/telegram/mutation-request.js';
import { createRoomState } from '../../src/agent/room-state.js';
import { registerWebsiteReply } from '../../src/agent/messages-poll.js';
import { followUpSkipReason } from '../../src/agent/follow-up.js';
import { runWinWatch } from '../../src/agent/win-watch.js';

const H = 3_600_000;
function setup() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'item56-')), 't.sqlite'));
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  return { db, queue, mutations, roomState: createRoomState(db) };
}
const cfg = { enabled: true, afterHours: 24, maxPerRoom: 1, maxAgeDays: 7 };

test('owner replied on the website → room answered, follow-up due after 24h', () => {
  const { roomState } = setup();
  const at = new Date(Date.now() - 26 * H).toISOString();
  const msgs = [
    { id: '1', text: 'سلام، هزینه؟', isOwn: false, createdAt: new Date(Date.now() - 27 * H).toISOString() },
    { id: '2', text: 'سلام، حدود ۳ میلیون تومان', isOwn: true, createdAt: at },
  ];
  assert.equal(registerWebsiteReply(roomState, 'r1', msgs), true);
  const t = roomState.getThread('r1');
  assert.equal(t.phase, 'answered');
  assert.equal(t.lastSentAt, at);
  assert.equal(t.answeredVia, 'website');
  assert.equal(followUpSkipReason({ thread: t, decision: roomState.getDecision('r1'), cfg }), null);
  // same message again → no change
  assert.equal(registerWebsiteReply(roomState, 'r1', msgs), false);
});

test('latest message from client or text the bot sent → not re-registered', () => {
  const { roomState } = setup();
  assert.equal(
    registerWebsiteReply(roomState, 'r2', [
      { id: '1', text: 'ما', isOwn: true, createdAt: new Date(Date.now() - 3 * H).toISOString() },
      { id: '2', text: 'سؤال', isOwn: false, createdAt: new Date(Date.now() - 2 * H).toISOString() },
    ]),
    false
  );
  roomState.setThread('r3', { phase: 'answered', lastSentAt: new Date(Date.now() - 5 * H).toISOString(), lastSentText: 'سلام،  پیام ربات' });
  const before = roomState.getThread('r3').lastSentAt;
  assert.equal(registerWebsiteReply(roomState, 'r3', [{ id: '9', text: 'سلام، پیام ربات', isOwn: true, createdAt: new Date().toISOString() }]), false);
  assert.equal(roomState.getThread('r3').lastSentAt, before);
});

function bidsApi(pages) {
  return {
    client: { hasAuth: true },
    notifications: { list: async () => ({ notifications: [] }) },
    rooms: { list: async () => ({ rooms: [{ id: '66', guestName: 'سارا', raw: { project_id: 902 } }] }) },
    user: { me: async () => ({ id: 777 }) },
    bids: { listMine: async ({ page }) => ({ bids: pages[page - 1] || [], pagination: { lastPage: pages.length } }) },
  };
}

test('win by bid status: baseline seeds old wins silently, then a new accepted bid → win + HITL approval', async () => {
  const s = setup();
  const old = { id: '1', projectId: '901', status: 'completed', project: { title: 'قدیمی' } };
  const pending = { id: '2', projectId: '902', status: 'pending', project: { title: 'ربات تلگرام' } };
  const first = await runWinWatch({ db: s.db, api: bidsApi([[old, pending]]), roomState: s.roomState, mutations: s.mutations });
  assert.equal(first.wins.length, 0);
  assert.ok(first.checked.bids >= 2);
  const accepted = { ...pending, status: 'in progress' };
  const second = await runWinWatch({ db: s.db, api: bidsApi([[old, accepted]]), roomState: s.roomState, mutations: s.mutations });
  assert.equal(second.wins.length, 1);
  assert.equal(second.wins[0].source, 'bid_status');
  assert.equal(second.wins[0].roomId, '66');
  assert.ok(second.wins[0].approval?.approvalId, 'post-win message waits for approval');
  const third = await runWinWatch({ db: s.db, api: bidsApi([[old, accepted]]), roomState: s.roomState, mutations: s.mutations });
  assert.equal(third.wins.length, 0);
});
