/**
 * Phase D: scheduled follow-up + win detection.
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
import { getTodayAutoCounts } from '../../src/telegram/agent-settings.js';
import { runFollowUpScan, followUpSkipReason, followUpTemplate } from '../../src/agent/follow-up.js';
import { runWinWatch, formatWinNotice, getLatestPostWin } from '../../src/agent/win-watch.js';
import { formatFollowUpNotice } from '../../src/telegram/send-notices.js';
import { createScheduler } from '../../src/worker/scheduler.js';
import { handleJob } from '../../src/worker/handlers.js';

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-d-')), 't.sqlite'));
}

const H = 3_600_000;

function setup() {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  const roomState = createRoomState(db);
  return { db, queue, gate, mutations, roomState };
}

function answeredRoom(roomState, roomId, hoursAgo) {
  roomState.setCard(roomId, {
    roomId,
    guestName: 'نیما',
    clientUserId: '42',
    messages: [{ id: '1', text: 'سلام، قیمت؟', isOwn: false }, { id: '2', text: 'سلام، حدود ۵ میلیون', isOwn: true }],
  });
  roomState.markAnswered(roomId, { lastSentText: 'سلام، حدود ۵ میلیون' });
  roomState.setThread(roomId, { lastSentAt: new Date(Date.now() - hoursAgo * H).toISOString() });
}

const cfg = { enabled: true, afterHours: 24, maxPerRoom: 1, maxAgeDays: 7 };

test('followUpSkipReason covers the cases', () => {
  const now = Date.now();
  const sent = new Date(now - 30 * H).toISOString();
  assert.equal(followUpSkipReason({ thread: { lastSentAt: sent }, cfg, now }), null);
  assert.equal(followUpSkipReason({ thread: { lastSentAt: new Date(now - 2 * H).toISOString() }, cfg, now }), 'not_yet');
  assert.equal(
    followUpSkipReason({ thread: { lastSentAt: sent, lastInboundAt: new Date(now - H).toISOString() }, cfg, now }),
    'client_replied'
  );
  assert.equal(followUpSkipReason({ thread: { lastSentAt: sent, followUpCount: 1 }, cfg, now }), 'max_reached');
  assert.equal(followUpSkipReason({ thread: { lastSentAt: new Date(now - 10 * 24 * H).toISOString() }, cfg, now }), 'too_old');
  assert.equal(followUpSkipReason({ thread: { lastSentAt: sent }, cfg: { ...cfg, enabled: false }, now }), 'disabled');
  assert.equal(followUpSkipReason({ thread: { lastSentAt: sent }, cfg, now, pendingSend: true }), 'pending_send');
  assert.equal(followUpSkipReason({ thread: { lastSentAt: sent, followUpDraftedFor: sent }, cfg, now }), 'already_drafted');
});

test('follow-up scan drafts once, HITL by default, not counted as auto', async () => {
  const s = setup();
  answeredRoom(s.roomState, '10', 30);
  answeredRoom(s.roomState, '11', 2); // too early
  const out = await runFollowUpScan({ db: s.db, roomState: s.roomState, queue: s.queue, mutations: s.mutations });
  const item = out.items.find((i) => i.roomId === '10');
  assert.equal(item.status, 'pending_approval');
  assert.ok(!out.items.some((i) => i.roomId === '11'));
  const job = s.db.prepare("select payload_json, requested_by from jobs where goal='messages.send'").get();
  const p = JSON.parse(job.payload_json);
  assert.equal(p.followUp, true);
  assert.equal(p.receptorId, '42');
  assert.equal(job.requested_by, 'followup');
  assert.equal(getTodayAutoCounts(s.db).messages, 0);
  // second run: pending approval exists → no duplicate
  const again = await runFollowUpScan({ db: s.db, roomState: s.roomState, queue: s.queue, mutations: s.mutations });
  assert.equal(again.items.filter((i) => i.status === 'pending_approval').length, 0);
  assert.equal(s.db.prepare("select count(*) n from jobs where goal='messages.send'").get().n, 1);
});

test('follow-up after owner rejection is not re-drafted for the same message', async () => {
  const s = setup();
  answeredRoom(s.roomState, '12', 30);
  await runFollowUpScan({ db: s.db, roomState: s.roomState, queue: s.queue, mutations: s.mutations });
  const appr = s.db.prepare("select approval_id from approvals where status='pending'").get();
  s.queue.decideApproval(appr.approval_id, { approve: false, decidedBy: 'owner' });
  const again = await runFollowUpScan({ db: s.db, roomState: s.roomState, queue: s.queue, mutations: s.mutations });
  assert.equal(again.items.length, 0);
});

test('forced approvals are never recorded as automatic sends', () => {
  const s = setup();
  s.gate.settings.update({ mode: 'auto', toggles: { autoReplyMessages: true }, approvalPreviewFirstN: 0, rules: { messageAuto: { enabled: true } } });
  s.mutations.request({
    action: 'messages.send',
    payload: { roomId: '1', text: 'x' },
    gateCtx: { source: 'auto', roomId: '1', matchScore: 90 },
    forceRequireApproval: true,
  });
  assert.equal(getTodayAutoCounts(s.db).messages, 0);
});

test('follow-up in full_auto with live allowed + LLM goes through the gate automatically', async () => {
  const s = setup();
  s.gate.settings.update({
    mode: 'auto',
    chatAiMode: 'full_auto',
    toggles: { autoReplyMessages: true },
    approvalPreviewFirstN: 0,
    rules: { messageAuto: { enabled: true } },
  });
  answeredRoom(s.roomState, '20', 30);
  const llm = {
    async draftChatReply() {
      return { ok: true, source: 'llm', data: { reply_text: 'سلام نیما جان، فرصت کردید پیام قبلی را ببینید؟', confidence: 0.9 } };
    },
  };
  const out = await runFollowUpScan({
    db: s.db,
    roomState: s.roomState,
    queue: s.queue,
    mutations: s.mutations,
    llm,
    getAllowLiveAutoSend: () => true,
  });
  assert.equal(out.items[0].status, 'queued_auto');
  assert.equal(getTodayAutoCounts(s.db).messages, 1);
  // live off → HITL
  const s2 = setup();
  s2.gate.settings.update({ mode: 'auto', chatAiMode: 'full_auto', toggles: { autoReplyMessages: true }, rules: { messageAuto: { enabled: true } } });
  answeredRoom(s2.roomState, '21', 30);
  const out2 = await runFollowUpScan({ db: s2.db, roomState: s2.roomState, queue: s2.queue, mutations: s2.mutations, llm, getAllowLiveAutoSend: () => false });
  assert.equal(out2.items[0].status, 'pending_approval');
});

test('follow-up copy is polite Persian without dashes', () => {
  const t = followUpTemplate('نیما');
  assert.match(t, /سلام نیما/);
  const n = formatFollowUpNotice({ guestName: 'نیما', text: t });
  assert.match(n, /تأییدها/);
  for (const x of [t, n]) assert.doesNotMatch(x, /[\u2014\u2013]/);
});

function fakeApi({ notifications = [], project = null, rooms = [], me = { id: 777 } } = {}) {
  return {
    client: { hasAuth: true },
    notifications: { list: async () => ({ notifications }) },
    projects: { get: async () => ({ project }) },
    rooms: { list: async () => ({ rooms }) },
    user: { me: async () => me },
  };
}

test('win watch: notification win → approval card, persisted, deduped', async () => {
  const s = setup();
  const n = {
    id: 'n1',
    title: 'پیشنهاد شما پذیرفته شد',
    body: 'تبریک! کارفرما شما را انتخاب کرد',
    createdAt: new Date().toISOString(),
    raw: { project_id: 555, room_id: 88 },
  };
  s.roomState.setCard('88', { roomId: '88', guestName: 'مهسا' });
  const api = fakeApi({ notifications: [n] });
  const out = await runWinWatch({ db: s.db, api, roomState: s.roomState, mutations: s.mutations });
  assert.equal(out.wins.length, 1);
  const w = out.wins[0];
  assert.equal(w.roomId, '88');
  assert.ok(w.approval?.approvalId);
  assert.match(w.draftText, /سلام مهسا/);
  assert.equal(getLatestPostWin(s.db).key, 'n:n1');
  const job = s.db.prepare("select requested_by, status from jobs where goal='messages.send'").get();
  assert.equal(job.requested_by, 'post_win');
  assert.equal(job.status, 'waiting_for_approval');
  const again = await runWinWatch({ db: s.db, api, roomState: s.roomState, mutations: s.mutations });
  assert.equal(again.wins.length, 0);
  const text = formatWinNotice(w);
  assert.match(text, /تبریک/);
  assert.match(text, /تأییدها/);
});

test('win watch first run does not replay old win notifications', async () => {
  const s = setup();
  const old = { id: 'old', title: 'تبریک، انتخاب شدید', createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), raw: {} };
  const out = await runWinWatch({ db: s.db, api: fakeApi({ notifications: [old] }), roomState: s.roomState, mutations: s.mutations });
  assert.equal(out.baseline, true);
  assert.equal(out.wins.length, 0);
});

test('win watch: project we bid on assigned to us → win', async () => {
  const s = setup();
  s.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('postwin:seen', JSON.stringify({ keys: [] }), new Date().toISOString());
  const job = s.queue.create({ goal: 'bids.submit', requiresApproval: false, payload: { projectId: 901 } });
  s.db.prepare("update jobs set status='succeeded' where job_id=?").run(job.jobId);
  const api = fakeApi({
    project: { id: '901', title: 'ربات تلگرام', freelancerId: 777 },
    rooms: [{ id: '66', guestName: 'امید', raw: { project_id: 901 } }],
  });
  const out = await runWinWatch({ db: s.db, api, roomState: s.roomState, mutations: s.mutations });
  assert.equal(out.wins.length, 1);
  assert.equal(out.wins[0].source, 'project_status');
  assert.equal(out.wins[0].roomId, '66');
});

test('worker wins.scan emits post_win.detected; scheduler has the new jobs', async () => {
  const s = setup();
  const n = { id: 'n2', title: 'پروژه به شما واگذار شد', createdAt: new Date().toISOString(), raw: {} };
  const events = [];
  const res = await handleJob(
    { db: s.db, queue: s.queue, api: fakeApi({ notifications: [n] }), mutations: s.mutations, onEvent: (t, p) => events.push([t, p]) },
    { jobId: 'x', goal: 'wins.scan', payload: {} }
  );
  assert.equal(res.ok, true);
  assert.ok(events.some((e) => e[0] === 'post_win.detected'));
  const sched = createScheduler({ db: s.db, queue: s.queue });
  sched.ensureDefaults?.();
  const names = s.db.prepare('select name, capability, interval_ms from schedules').all();
  const f = names.find((r) => r.name === 'followup_scan');
  const w = names.find((r) => r.name === 'wins_scan');
  assert.equal(f?.capability, 'followup.scan');
  assert.equal(w?.interval_ms, 600000);
});

test('follow-up wizard + rules card + settings clamp', async () => {
  const { parseFollowUpWizard } = await import('../../src/telegram/rule-wizard.js');
  const { formatRulesCard, parseCallbackData, rulesInlineKeyboard } = await import('../../src/telegram/ui.js');
  const { createAgentSettingsStore } = await import('../../src/telegram/agent-settings.js');
  const r = parseFollowUpWizard('وضعیت: روشن\nبعد از: ۴۸\nحداکثر: ۲');
  assert.deepEqual(r.patch, { enabled: true, afterHours: 48, maxPerRoom: 2 });
  assert.equal(parseFollowUpWizard('حداکثر: ۵').ok, false);
  assert.equal(parseCallbackData('wiz:followup').type, 'wiz_followup');
  assert.ok(rulesInlineKeyboard().inline_keyboard.flat().some((b) => b.callback_data === 'wiz:followup'));
  const store = createAgentSettingsStore(tmpDb());
  assert.deepEqual(store.get().followUp, { enabled: true, afterHours: 24, maxPerRoom: 1, maxAgeDays: 7 });
  store.update({ followUp: { maxPerRoom: 9 } });
  assert.equal(store.get().followUp.maxPerRoom, 2);
  assert.match(formatRulesCard(store.get()), /پیگیری: بعد از ۲۴ ساعت/);
});
