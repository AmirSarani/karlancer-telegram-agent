import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import {
  resolveIsOwn,
  markOwnMessages,
  buildConversationHistory,
  latestClientTurn,
  detectNegotiation,
  evaluateDiscount,
} from '../../src/agent/conversation.js';
import { normalizeInboundMessage } from '../../src/agent/message-normalize.js';
import { adaptDraftWithNote, analyzeRoomWithLlm } from '../../src/agent/analyze-llm.js';
import { createLlmProvider, CHAT_FALLBACK_TEXT } from '../../src/llm/provider.js';
import { getOwnUserId } from '../../src/agent/own-identity.js';
import { createRoomState } from '../../src/agent/room-state.js';
import { createChatContinuum, autoSafetyCheck } from '../../src/agent/chat-continuum.js';
import { createPermissionGate } from '../../src/telegram/permission-gate.js';
import { createMutationRequester } from '../../src/telegram/mutation-request.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { REPLY_SYSTEM } from '../../src/agent/prompts.js';

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-')), 't.sqlite'));
}

const CLIENT =
  'سلام، یه سایت فروشگاهی برای فروش لوازم آرایشی می‌خوام، حدود ۵۰ محصول، درگاه پرداخت، پنل مدیریت، ریسپانسیو، کی تحویل می‌دید و چقدر هزینه‌ش میشه؟';

function mockLlm({ conf = 0.8, fallback = false } = {}) {
  const calls = [];
  return {
    calls,
    enabled: true,
    async analyzeProject(p) {
      calls.push({ fn: 'analyze', p });
      return {
        ok: true,
        source: fallback ? 'deterministic_fallback' : 'llm',
        fallback,
        data: {
          summary: 'فروشگاه لوازم آرایشی',
          requirements: ['۵۰ محصول', 'درگاه'],
          complexity: 'medium',
          estimated_days: 20,
          price_range: { min: 1, max: 2 },
          confidence: conf,
        },
      };
    },
    async draftChatReply(a) {
      calls.push({ fn: 'draft', a });
      if (fallback) {
        return { ok: true, fallback: true, source: 'deterministic_fallback', data: { reply_text: CHAT_FALLBACK_TEXT, confidence: 0.3 } };
      }
      return { ok: true, source: 'llm', data: { reply_text: 'سلام، فروشگاه لوازم آرایشی را انجام می‌دهم.', confidence: conf } };
    },
  };
}

test('own-message detection via sender_id when is_me missing', () => {
  const m = normalizeInboundMessage({ id: 5, message: 'hi', sender_id: 1386700, receptor_id: 502998 });
  assert.equal(m.senderId, '1386700');
  assert.equal(m.isOwn, null);
  assert.equal(resolveIsOwn(m, '1386700'), true);
  assert.equal(resolveIsOwn({ senderId: '502998', isOwn: null }, '1386700'), false);
  assert.equal(resolveIsOwn({ isOwn: false, senderId: '1386700' }, '1386700'), false, 'explicit flag wins');
  const marked = markOwnMessages([m, { id: 6, text: 'x', senderId: '9' }], '1386700');
  assert.deepEqual(marked.map((x) => x.isOwn), [true, false]);
});

test('history is chronological, two-sided, trimmed; latest client turn', () => {
  const msgs = [
    { id: '3', text: 'یکم گرونه', isOwn: false, createdAt: '2026-09-25T10:03:00Z' },
    { id: '1', text: CLIENT, isOwn: false, createdAt: '2026-09-25T10:00:00Z' },
    { id: '2', text: 'پاسخ ما', isOwn: true, createdAt: '2026-09-25T10:01:00Z' },
    { id: '4', text: 'نمونه کار دارید؟', isOwn: false, createdAt: '2026-09-25T10:04:00Z' },
  ];
  const h = buildConversationHistory(msgs, { max: 12 });
  assert.deepEqual(h.map((x) => x.role), ['client', 'me', 'client', 'client']);
  assert.deepEqual(latestClientTurn(h), ['یکم گرونه', 'نمونه کار دارید؟']);
  assert.equal(buildConversationHistory(msgs, { max: 2 }).length, 2);
});

test('negotiation detection with Persian digits + discount limits', () => {
  const n = detectNegotiation('یکم گرونه، ۲۰٪ تخفیف میدید؟ نمونه کار دارید؟');
  assert.equal(n.askedDiscount, true);
  assert.equal(n.requestedPct, 20);
  assert.equal(n.askedPortfolio, true);
  const over = evaluateDiscount(n, { basePrice: 30_000_000, maxDiscountPct: 10 });
  assert.equal(over.needsOwner, true);
  assert.equal(over.reason, 'discount_over_limit');
  const ok = evaluateDiscount({ askedDiscount: true, requestedPct: 5 }, { basePrice: 30_000_000, maxDiscountPct: 10 });
  assert.equal(ok.needsOwner, false);
  assert.equal(ok.minPrice, 27_000_000);
  const floor = evaluateDiscount({ askedDiscount: true, requestedPct: 8 }, { basePrice: 30_000_000, maxDiscountPct: 10, priceFloorToman: 29_000_000 });
  assert.equal(floor.reason, 'below_price_floor');
  const time = detectNegotiation(CLIENT);
  assert.equal(time.askedTime, true);
  assert.equal(time.askedPrice, true);
  assert.equal(time.askedDiscount, false);
});

test('adaptDraftWithNote sends CLIENT text as employer_message; note is added separately', async () => {
  const llm = mockLlm();
  const out = await adaptDraftWithNote({
    roomContext: { guestName: 'مریم', messages: [{ id: '1', text: CLIENT, isOwn: false }] },
    currentDraft: 'سلام',
    ownerNote: 'قیمت را کمتر نگو',
    internalNote: 'قیمت داخلی ۳۰ میلیون تومان',
    llm,
    mode: 'analyze',
    analysis: { ok: true, data: { estimated_days: 20, requirements: ['درگاه'] } },
  });
  const call = llm.calls.find((c) => c.fn === 'draft').a;
  assert.equal(call.employerMessage, CLIENT);
  assert.match(call.internalNote, /قیمت را کمتر نگو/);
  assert.match(call.internalNote, /۳۰ میلیون/);
  assert.equal(call.history.length, 1);
  assert.equal(call.analysis.estimated_days, 20);
  assert.equal(out.llmUsed, true);
  assert.equal(out.fallback, false);
});

test('analyzeRoomWithLlm analyzes direct chats from client messages', async () => {
  const llm = mockLlm();
  const a = await analyzeRoomWithLlm({
    roomContext: { messages: [{ id: '1', text: CLIENT, isOwn: false }] },
    llm,
  });
  const p = llm.calls[0].p;
  assert.match(p.description, /لوازم آرایشی/);
  assert.equal(p.clientMessages.length, 1);
  assert.equal(a.ok, true);
  assert.equal(a.confidence, 0.8);
});

test('provider fallback is flagged and never counts as LLM draft', async () => {
  const llm = createLlmProvider({ apiKey: '', enabled: false });
  const r = await llm.draftChatReply({ employerMessage: 'سلام' });
  assert.equal(r.fallback, true);
  const out = await adaptDraftWithNote({
    roomContext: { messages: [{ id: '1', text: CLIENT, isOwn: false }] },
    currentDraft: 'سلام',
    ownerNote: 'x',
    llm,
    mode: 'analyze',
  });
  assert.equal(out.llmUsed, false);
  assert.equal(out.fallback, true);
  assert.notEqual(out.text, CHAT_FALLBACK_TEXT);
});

test('getOwnUserId resolves via api.user.me and caches', async () => {
  const db = tmpDb();
  let n = 0;
  const api = { user: { me: async () => { n += 1; return { id: '1386700' }; } } };
  assert.equal(await getOwnUserId({ api, db }), '1386700');
  assert.equal(await getOwnUserId({ api, db }), '1386700');
  assert.equal(n, 1);
  assert.equal(await getOwnUserId({ api: { user: { me: async () => { throw new Error('x'); } } }, db }), '1386700');
});

test('REPLY_SYSTEM carries negotiation / portfolio / Toman guidance', () => {
  assert.match(REPLY_SYSTEM, /تخفیف/);
  assert.match(REPLY_SYSTEM, /نمونه‌کار/);
  assert.match(REPLY_SYSTEM, /تومان/);
  assert.doesNotMatch(REPLY_SYSTEM, /[\u2014\u2013]/);
});

function autoSetup({ llm, configured = true }) {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  gate.settings.update({
    mode: 'auto',
    chatAiMode: 'full_auto',
    toggles: { autoReplyMessages: true },
    approvalPreviewFirstN: 0,
    rules: { messageAuto: { enabled: true, ...(configured ? { budgetMin: 1 } : {}) } },
  });
  const roomState = createRoomState(db);
  const c = createChatContinuum({ db, roomState, llm, gate, mutations, getAllowLiveAutoSend: () => true });
  return { db, c, roomState };
}

const card = (text) => ({
  roomId: '77',
  guestName: 'مریم',
  clientUserId: '502998',
  messages: [{ id: '1', text, isOwn: false, createdAt: '2026-09-25T10:00:00Z' }],
  freshInboundCount: 1,
});

test('full_auto never auto-sends the deterministic fallback', async () => {
  const { db, c } = autoSetup({ llm: mockLlm({ fallback: true }) });
  const out = await c.processInboundCard(card(CLIENT));
  assert.equal(out.continuumAction, 'auto_hitl');
  assert.equal(out.gateVerdict.reason, 'llm_fallback');
  assert.equal(db.prepare('select count(*) n from jobs').get().n, 0);
});

test('full_auto low confidence → owner card', async () => {
  const { c } = autoSetup({ llm: mockLlm({ conf: 0.3 }) });
  const out = await c.processInboundCard(card(CLIENT));
  assert.equal(out.gateVerdict.reason, 'low_confidence');
});

test('full_auto discount above limit → owner card', async () => {
  const { c } = autoSetup({ llm: mockLlm() });
  const out = await c.processInboundCard(card('یکم گرونه، ۲۰٪ تخفیف میدید؟'));
  assert.equal(out.continuumAction, 'auto_hitl');
  assert.equal(out.gateVerdict.reason, 'discount_over_limit');
});

test('full_auto good LLM reply is queued with receptorId (still via gate + queue)', async () => {
  const { db, c } = autoSetup({ llm: mockLlm() });
  const out = await c.processInboundCard(card(CLIENT));
  assert.equal(out.continuumAction, 'auto_sent');
  const job = db.prepare("select payload_json from jobs where goal='messages.send'").get();
  assert.equal(JSON.parse(job.payload_json).receptorId, '502998');
});

test('autoSafetyCheck passes clean pipeline', () => {
  assert.equal(
    autoSafetyCheck({ llmUsed: true, fallback: false, analysis: { ok: true }, confidence: 0.9, clientText: 'سلام' }, {}),
    null
  );
});
