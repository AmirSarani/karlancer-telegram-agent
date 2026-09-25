/**
 * Phase B: full-auto works safely (default criterion, auto-only daily count,
 * answered-after-POST, send notices, scan-prepare skips, token budget, wizards).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createPermissionGate, DEFAULT_MESSAGE_SCORE_THRESHOLD } from '../../src/telegram/permission-gate.js';
import { createMutationRequester } from '../../src/telegram/mutation-request.js';
import { getTodayAutoCounts, tehranDayBounds } from '../../src/telegram/agent-settings.js';
import { createRoomState } from '../../src/agent/room-state.js';
import { createChatContinuum, autoSafetyCheck } from '../../src/agent/chat-continuum.js';
import { handleJob } from '../../src/worker/handlers.js';
import { scanSkipReason } from '../../src/agent/scan-prepare.js';
import { parseMessageRuleWizard, parsePricingWizard } from '../../src/telegram/rule-wizard.js';
import {
  formatMessageSentNotice,
  formatMessageBlockedNotice,
  blockReasonFa,
} from '../../src/telegram/send-notices.js';
import { formatRulesCard, parseCallbackData, rulesInlineKeyboard } from '../../src/telegram/ui.js';
import { formatRoomCard } from '../../src/telegram/room-card.js';

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-')), 't.sqlite'));
}

function mockLlm({ conf = 0.8 } = {}) {
  return {
    enabled: true,
    async analyzeProject() {
      return {
        ok: true,
        source: 'llm',
        data: { summary: 'فروشگاه', requirements: ['درگاه'], estimated_days: 20, confidence: conf },
      };
    },
    async draftChatReply() {
      return { ok: true, source: 'llm', data: { reply_text: 'سلام، انجام می‌دهم.', confidence: conf } };
    },
  };
}

function autoSetup({ llm = mockLlm(), rule = { enabled: true }, preview = 0, budget = null } = {}) {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  gate.settings.update({
    mode: 'auto',
    chatAiMode: 'full_auto',
    toggles: { autoReplyMessages: true },
    approvalPreviewFirstN: preview,
    rules: { messageAuto: rule },
  });
  const roomState = createRoomState(db);
  const c = createChatContinuum({ db, roomState, llm, gate, mutations, budget, getAllowLiveAutoSend: () => true });
  return { db, queue, gate, c, roomState };
}

const CLIENT = 'سلام، یک سایت فروشگاهی با درگاه پرداخت می‌خواهم. هزینه و زمان تحویل چقدر است؟';
const card = (text = CLIENT, roomId = '77') => ({
  roomId,
  guestName: 'مریم',
  clientUserId: '502998',
  messages: [{ id: '1', text, isOwn: false, createdAt: '2026-09-25T10:00:00Z' }],
  freshInboundCount: 1,
});

// —— gate: default criterion ——

test('enabled message rule without criteria uses default confidence threshold', () => {
  const gate = createPermissionGate(tmpDb());
  gate.settings.update({
    mode: 'auto',
    toggles: { autoReplyMessages: true },
    approvalPreviewFirstN: 0,
    rules: { messageAuto: { enabled: true } },
  });
  assert.equal(DEFAULT_MESSAGE_SCORE_THRESHOLD, 60);
  assert.equal(gate.check('messages.send', { source: 'auto', matchScore: 80 }).decision, 'auto_allow');
  const low = gate.check('messages.send', { source: 'auto', matchScore: 40 });
  assert.equal(low.decision, 'require_approval');
  assert.equal(low.reason, 'score_below_threshold');
  const none = gate.check('messages.send', { source: 'auto' });
  assert.equal(none.reason, 'score_unavailable');
});

test('keyword criterion checks client text, not our draft', () => {
  const gate = createPermissionGate(tmpDb());
  gate.settings.update({
    mode: 'auto',
    toggles: { autoReplyMessages: true },
    approvalPreviewFirstN: 0,
    rules: { messageAuto: { enabled: true, keywords: ['وردپرس'] } },
  });
  assert.equal(
    gate.check('messages.send', { source: 'auto', text: 'وردپرس', clientText: 'سایت فروشگاهی' }).reason,
    'keyword_mismatch'
  );
  assert.equal(
    gate.check('messages.send', { source: 'auto', text: 'x', clientText: 'سایت وردپرس' }).decision,
    'auto_allow'
  );
});

// —— daily count ——

test('tehranDayBounds: 23:00 UTC is next Tehran day', () => {
  const b = tehranDayBounds(Date.parse('2026-09-25T21:00:00Z'));
  assert.equal(b.day, '2026-09-26');
  assert.equal(b.startIso, '2026-09-25T20:30:00.000Z');
});

test('owner confirms are not counted in the daily auto limit; previews counted separately', () => {
  const db = tmpDb();
  const gate = createPermissionGate(db);
  gate.recordDecision('messages.send', { decision: 'auto_allow', reason: 'owner_confirm' }, { roomId: '1' });
  gate.recordDecision('messages.send', { decision: 'auto_allow', reason: 'auto_rule_matched' }, { roomId: '2' });
  gate.recordDecision('messages.send', { decision: 'require_approval', reason: 'auto_preview_card' }, { roomId: '3' });
  const c = getTodayAutoCounts(db);
  assert.equal(c.messages, 1);
  assert.equal(c.previews, 1);
  const row = db.prepare("select count(*) n from audit_log where action = 'owner.messages.send'").get();
  assert.equal(row.n, 1);
});

test('yesterday (Tehran) auto sends do not count today', () => {
  const db = tmpDb();
  createPermissionGate(db).recordDecision('messages.send', { decision: 'auto_allow', reason: 'auto_rule_matched' });
  const tomorrow = Date.now() + 2 * 86_400_000;
  assert.equal(getTodayAutoCounts(db, { now: tomorrow }).messages, 0);
  assert.equal(getTodayAutoCounts(db).messages, 1);
});

// —— continuum: answered only after worker POST ——

test('full_auto with default criterion queues send as «sending», not answered', async () => {
  const { c, roomState, db } = autoSetup();
  const out = await c.processInboundCard(card());
  assert.equal(out.continuumAction, 'auto_sent');
  assert.equal(roomState.getDecision('77').status, 'sending');
  assert.notEqual(roomState.getThread('77').phase, 'answered');
  assert.ok(roomState.getThread('77').pendingSendJobId);
  assert.equal(db.prepare("select count(*) n from jobs where goal='messages.send'").get().n, 1);
});

test('preview cards are recorded and used up before real auto sends', async () => {
  const { c, gate } = autoSetup({ preview: 1 });
  const first = await c.processInboundCard(card(CLIENT, '1'));
  assert.equal(first.continuumAction, 'auto_hitl');
  assert.equal(first.gateVerdict.reason, 'auto_preview_card');
  assert.equal(gate.getTodayAutoCounts().previews, 1);
  const second = await c.processInboundCard(card(CLIENT, '2'));
  assert.equal(second.continuumAction, 'auto_sent');
});

test('token budget exhausted → no LLM, owner card with token_budget_exceeded', async () => {
  let called = false;
  const llm = mockLlm();
  const wrapped = {
    ...llm,
    async draftChatReply(a) {
      called = true;
      return llm.draftChatReply(a);
    },
  };
  const budget = { decide: () => 'budget_exceeded' };
  const { c } = autoSetup({ llm: wrapped, budget });
  const out = await c.processInboundCard(card());
  assert.equal(called, false);
  assert.equal(out.continuumAction, 'auto_hitl');
  assert.equal(out.gateVerdict.reason, 'token_budget_exceeded');
});

test('autoSafetyCheck puts budget first', () => {
  assert.equal(autoSafetyCheck({ budgetExceeded: true, llmUsed: true }, {}).reason, 'token_budget_exceeded');
});

// —— worker: messages.send ——

function approvedSendJob(queue, payload, requestedBy = 'chat_continuum:full_auto') {
  const job = queue.create({ goal: 'messages.send', requiresApproval: true, payload, requestedBy });
  const appr = queue.getApprovalForJob(job.jobId);
  queue.decideApproval(appr.approval_id, { approve: true, decidedBy: 'test' });
  return queue.get(job.jobId);
}

test('worker marks answered only after POST success and emits message.sent', async () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const rs = createRoomState(db);
  rs.setCard('9', { roomId: '9', guestName: 'علی' });
  const job = approvedSendJob(queue, { roomId: '9', text: 'سلام، بله.' });
  const events = [];
  const api = { messages: { send: async () => ({ ok: true, status: 'sent' }) } };
  const res = await handleJob({ db, queue, api, onEvent: (t, p) => events.push([t, p]) }, job);
  assert.equal(res.ok, true);
  assert.equal(rs.getThread('9').phase, 'answered');
  assert.equal(rs.getDecision('9').status, 'answered');
  const sent = events.find((e) => e[0] === 'message.sent');
  assert.ok(sent);
  assert.equal(sent[1].auto, true);
  assert.equal(sent[1].guestName, 'علی');
});

test('worker POST failure → blocked, not answered, message.blocked', async () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const rs = createRoomState(db);
  const job = approvedSendJob(queue, { roomId: '9', text: 'سلام' }, 'telegram');
  const events = [];
  const api = { messages: { send: async () => ({ ok: false, status: 'unexpected_status' }) } };
  await handleJob({ db, queue, api, onEvent: (t, p) => events.push([t, p]) }, job);
  assert.notEqual(rs.getThread('9').phase, 'answered');
  assert.equal(rs.getDecision('9').status, 'blocked');
  const blocked = events.find((e) => e[0] === 'message.blocked');
  assert.equal(blocked[1].code, 'unexpected_status');
  assert.equal(blocked[1].auto, false);
});

test('double-send guard: newer send after job creation → no POST', async () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const rs = createRoomState(db);
  const job = approvedSendJob(queue, { roomId: '5', text: 'سلام' });
  rs.setThread('5', { lastSentAt: new Date(Date.now() + 60_000).toISOString() });
  let posted = false;
  const events = [];
  const api = { messages: { send: async () => { posted = true; return { ok: true }; } } };
  const res = await handleJob({ db, queue, api, onEvent: (t, p) => events.push([t, p]) }, job);
  assert.equal(posted, false);
  assert.equal(res.errorCode, 'superseded_by_newer_send');
  assert.equal(queue.get(job.jobId).status, 'needs_reconciliation');
  assert.ok(events.some((e) => e[0] === 'message.blocked' && e[1].code === 'superseded_by_newer_send'));
});

test('follow-up send increments followUpCount', async () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const rs = createRoomState(db);
  const job = approvedSendJob(queue, { roomId: '4', text: 'پیگیری', followUp: true }, 'followup');
  await handleJob({ db, queue, api: { messages: { send: async () => ({ ok: true }) } } }, job);
  assert.equal(rs.getThread('4').followUpCount, 1);
});

// —— scan-prepare skips ——

test('scanSkipReason: answered / sending / no fresh inbound / already carded', () => {
  const db = tmpDb();
  const rs = createRoomState(db);
  rs.markAnswered('1', { lastSentText: 'x' });
  assert.equal(scanSkipReason({ room: { unread: 0 }, roomState: rs, roomId: '1' }), 'already_answered');
  rs.setDecision('2', { status: 'sending' });
  assert.equal(scanSkipReason({ room: { unread: 1 }, roomState: rs, roomId: '2' }), 'sending');
  assert.equal(scanSkipReason({ room: { unread: 0 }, roomState: rs, roomId: '3' }), 'no_fresh_inbound');
  assert.equal(scanSkipReason({ room: { unread: 0 }, invite: { roomId: '3' }, roomState: rs, roomId: '3' }), null);
  rs.setCard('6', { roomId: '6', continuumAction: 'auto_hitl' });
  rs.setDecision('6', { status: 'pending' });
  assert.equal(scanSkipReason({ room: { unread: 2 }, roomState: rs, roomId: '6' }), 'already_carded');
  assert.equal(scanSkipReason({ room: { unread: 2 }, roomState: rs, roomId: '7' }), null);
});

// —— notices + UI ——

test('send notices are Persian, friendly and dash-free', () => {
  const a = formatMessageSentNotice({ guestName: 'مریم', auto: true, textPreview: 'سلام' });
  assert.match(a, /خودکار/);
  assert.match(a, /مریم/);
  const b = formatMessageBlockedNotice({ guestName: 'مریم', code: 'superseded_by_newer_send' });
  assert.match(b, /ارسال نشد/);
  assert.match(b, /تکراری/);
  assert.equal(blockReasonFa('weird_code'), 'ارسال انجام نشد.');
  for (const t of [a, b]) {
    assert.doesNotMatch(t, /[\u2014\u2013]/);
    assert.doesNotMatch(t, /Mutation|API|superseded/i);
  }
});

test('room card shows «در حال ارسال» and why auto did not send', () => {
  const t = formatRoomCard({
    roomId: '1',
    guestName: 'x',
    decisionStatus: 'sending',
    messages: [],
  });
  assert.match(t, /در حال ارسال/);
  const t2 = formatRoomCard({
    roomId: '1',
    guestName: 'x',
    pickPrompt: true,
    gateVerdict: { reasonFa: 'امتیاز اطمینان زیر آستانهٔ قانون' },
    messages: [],
  });
  assert.match(t2, /چرا خودکار نفرستادم/);
});

// —— wizards ——

test('message rule wizard parses Persian lines and digits', () => {
  const r = parseMessageRuleWizard('کلیدواژه: وردپرس، سئو\nحداقل بودجه: ۵٬۰۰۰٬۰۰۰\nحداقل اطمینان: ۷۰');
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch.keywords, ['وردپرس', 'سئو']);
  assert.equal(r.patch.budgetMin, 5_000_000);
  assert.equal(r.patch.matchScoreThreshold, 70);
  const clear = parseMessageRuleWizard('کلیدواژه: پاک');
  assert.deepEqual(clear.patch.keywords, []);
  assert.equal(parseMessageRuleWizard('حداقل اطمینان: ۱۵۰').ok, false);
  assert.equal(parseMessageRuleWizard('سلام').ok, false);
});

test('pricing wizard parses discount and floor', () => {
  const r = parsePricingWizard('تخفیف: ۱۵\nکف قیمت: ۳۰۰۰۰۰۰');
  assert.equal(r.ok, true);
  assert.equal(r.patch.maxDiscountPct, 15);
  assert.equal(r.patch.priceFloorToman, 3_000_000);
  assert.equal(parsePricingWizard('کف قیمت: پاک').patch.priceFloorToman, null);
  assert.equal(parsePricingWizard('تخفیف: ۹۰').ok, false);
});

test('rules keyboard + callbacks + card show default criterion', () => {
  const kb = rulesInlineKeyboard().inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(kb.includes('wiz:msg_rule'));
  assert.ok(kb.includes('wiz:pricing'));
  assert.equal(parseCallbackData('wiz:msg_rule').type, 'wiz_msg_rule');
  assert.equal(parseCallbackData('wiz:pricing').type, 'wiz_pricing');
  const t = formatRulesCard({ rules: { messageAuto: { enabled: true } }, pricing: { maxDiscountPct: 10 } });
  assert.match(t, /پیش‌فرض ۶۰٪/);
  assert.match(t, /سقف تخفیف/);
});
