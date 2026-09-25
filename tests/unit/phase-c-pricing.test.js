/**
 * Phase C: owner price question, price learning, Toman units.
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
import { createChatContinuum, shouldAskOwnerPrice } from '../../src/agent/chat-continuum.js';
import { decideChatPrice } from '../../src/agent/chat-price.js';
import {
  extractPriceFeatures,
  recordPriceSample,
  learnedPriceFor,
  parseTomanAmount,
  extractSentPrice,
  setRoomPriceAnswer,
  getRoomPriceAsk,
  getRoomPriceAnswer,
} from '../../src/agent/price-memory.js';
import { recommendPrice } from '../../src/intelligence/pricing.js';
import { handleJob } from '../../src/worker/handlers.js';
import { formatRoomCard, roomPriceKeyboard, parseRoomCallback, formatPriceAskLines } from '../../src/telegram/room-card.js';
import { createRoomFlows } from '../../src/telegram/room-flows.js';

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-c-')), 't.sqlite'));
}

function mockLlm({ conf = 0.85 } = {}) {
  return {
    enabled: true,
    async analyzeProject() {
      return { ok: true, source: 'llm', data: { summary: 'فروشگاه وردپرس', requirements: ['درگاه'], estimated_days: 15, confidence: conf } };
    },
    async draftChatReply(a) {
      const amount = a?.pricing?.labelFa ? ` هزینه حدود ${a.pricing.labelFa} است.` : '';
      return { ok: true, source: 'llm', data: { reply_text: `سلام، انجام می‌دهم.${amount}`, confidence: conf } };
    },
  };
}

function autoSetup({ db = tmpDb() } = {}) {
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  gate.settings.update({
    mode: 'auto',
    chatAiMode: 'full_auto',
    toggles: { autoReplyMessages: true },
    approvalPreviewFirstN: 0,
    rules: { messageAuto: { enabled: true } },
  });
  const roomState = createRoomState(db);
  const deps = { db, roomState, llm: mockLlm(), gate, mutations, getAllowLiveAutoSend: () => true };
  return { db, queue, gate, mutations, roomState, c: createChatContinuum(deps), deps };
}

const ASK = 'سلام، یک سایت فروشگاهی وردپرس می‌خواهم. هزینه‌اش چقدر می‌شود؟';
const noBudgetCard = (roomId = '31') => ({
  roomId,
  guestName: 'سارا',
  clientUserId: '9001',
  messages: [{ id: 'm1', text: ASK, isOwn: false, createdAt: '2026-09-25T10:00:00Z' }],
  freshInboundCount: 1,
});

test('Toman units: recommendPrice and deterministic ranges are TOMAN, not IRR', () => {
  const r = recommendPrice({ complexity: 'medium', pages: 5 });
  assert.equal(r.currency, 'TOMAN');
  assert.equal(r.range.currency, 'TOMAN');
});

test('parseTomanAmount handles Persian digits and scale words', () => {
  assert.equal(parseTomanAmount('۲۵ میلیون'), 25_000_000);
  assert.equal(parseTomanAmount('2.5 میلیون تومان'), 2_500_000);
  assert.equal(parseTomanAmount('۲۵٬۰۰۰٬۰۰۰'), 25_000_000);
  assert.equal(parseTomanAmount('800 هزار'), 800_000);
  assert.equal(parseTomanAmount('سلام'), null);
  assert.equal(parseTomanAmount('25'), null);
  assert.equal(extractSentPrice('هزینه حدود ۱۸ میلیون تومان است'), 18_000_000);
  assert.equal(extractSentPrice('۳ صفحه دارد'), null);
});

test('features: tags + category + scope', () => {
  const f = extractPriceFeatures({ clientText: ASK, analysis: { data: { requirements: ['a'], estimated_days: 10 } } });
  assert.ok(f.tags.includes('wordpress'));
  assert.ok(f.tags.includes('shop'));
  assert.equal(f.scope, 'small');
  assert.equal(f.days, 10);
});

test('learnedPriceFor: median of similar; confident only with ≥5 low-spread samples', () => {
  const db = tmpDb();
  const f = extractPriceFeatures({ clientText: ASK });
  const other = extractPriceFeatures({ clientText: 'ترجمه مقاله انگلیسی' });
  [20, 21, 22].forEach((m, i) => recordPriceSample(db, { amount: m * 1e6, source: 'sent', features: f, roomId: `r${i}` }));
  recordPriceSample(db, { amount: 1e6, source: 'sent', features: other, roomId: 'x' });
  let L = learnedPriceFor(db, f);
  assert.equal(L.count, 3);
  assert.equal(L.median, 21_000_000);
  assert.equal(L.confident, false);
  [21, 22].forEach((m, i) => recordPriceSample(db, { amount: m * 1e6, source: 'owner_answer', features: f, roomId: `s${i}` }));
  L = learnedPriceFor(db, f);
  assert.equal(L.count, 5);
  assert.equal(L.confident, true);
  // wide spread → not confident
  const db2 = tmpDb();
  [5, 10, 40, 80, 120].forEach((m, i) => recordPriceSample(db2, { amount: m * 1e6, source: 'sent', features: f, roomId: `w${i}` }));
  assert.equal(learnedPriceFor(db2, f).confident, false);
});

test('recordPriceSample dedupes same room + amount and rejects junk', () => {
  const db = tmpDb();
  const f = extractPriceFeatures({ clientText: ASK });
  assert.equal(recordPriceSample(db, { amount: 5e6, source: 'owner_answer', features: f, roomId: '1' }).ok, true);
  assert.equal(recordPriceSample(db, { amount: 5e6, source: 'sent', features: f, roomId: '1' }).reason, 'duplicate');
  assert.equal(recordPriceSample(db, { amount: 5, source: 'sent', features: f }).ok, false);
});

test('decideChatPrice order: owner answer → confident learned → budget → ask', () => {
  const db = tmpDb();
  const card = noBudgetCard();
  let p = decideChatPrice({ db, card, clientText: ASK });
  assert.equal(p.needsOwnerPrice, true);
  assert.equal(p.firstTimeType, true);
  const budgeted = decideChatPrice({ db, card: { ...card, project: { minBudget: 10e6, maxBudget: 20e6 } }, clientText: ASK });
  assert.equal(budgeted.source, 'project_budget');
  assert.equal(budgeted.needsOwnerPrice, false);
  const f = extractPriceFeatures({ clientText: ASK });
  [30, 31, 32, 30, 31].forEach((m, i) => recordPriceSample(db, { amount: m * 1e6, source: 'sent', features: f, roomId: `q${i}` }));
  p = decideChatPrice({ db, card, clientText: ASK });
  assert.equal(p.source, 'learned');
  assert.equal(p.basedOnN, 5);
  assert.equal(p.needsOwnerPrice, false);
  setRoomPriceAnswer(db, '31', { amount: 44e6 });
  p = decideChatPrice({ db, card, clientText: ASK });
  assert.equal(p.source, 'owner_answer');
  assert.equal(p.amount, 44e6);
});

test('shouldAskOwnerPrice only when price matters', () => {
  const price = { needsOwnerPrice: true, source: 'pricing_rules' };
  assert.equal(shouldAskOwnerPrice({ price, pipe: { negotiation: { askedPrice: true } }, safety: null, card: {} }), true);
  assert.equal(shouldAskOwnerPrice({ price, pipe: { negotiation: {} }, safety: null, card: {} }), false);
  assert.equal(
    shouldAskOwnerPrice({ price, pipe: { negotiation: { askedPrice: true } }, safety: { reason: 'llm_fallback' }, card: {} }),
    false
  );
  assert.equal(
    shouldAskOwnerPrice({ price: { source: 'owner_answer' }, pipe: { negotiation: { askedPrice: true } }, card: {} }),
    false
  );
});

test('full_auto without budget → «چه قیمتی بدهم؟» card, no send job', async () => {
  const { c, db, roomState } = autoSetup();
  const out = await c.processInboundCard(noBudgetCard());
  assert.equal(out.continuumAction, 'price_ask');
  assert.ok(out.priceAsk.suggested > 0);
  assert.equal(db.prepare("select count(*) n from jobs where goal='messages.send'").get().n, 0);
  assert.equal(roomState.getDecision('31').detail, 'price_ask');
  assert.ok(getRoomPriceAsk(db, '31').suggested > 0);
  const text = formatRoomCard(out);
  assert.match(text, /چه قیمتی بدهم؟/);
  assert.doesNotMatch(text, /IRR|ریال/);
});

test('owner accepts suggestion → answer stored, sample learned, resume job queued; resume continues auto path', async () => {
  const s = autoSetup();
  await s.c.processInboundCard(noBudgetCard());
  const flows = createRoomFlows({ db: s.db, queue: s.queue, api: null, llm: null, menuOpts: () => ({}), gate: s.gate, mutations: s.mutations });
  const replies = [];
  const ctx = { from: { id: 1 }, reply: async (t) => replies.push(t) };
  await flows.acceptSuggestedPrice(ctx, '31');
  const ans = getRoomPriceAnswer(s.db, '31');
  assert.ok(ans.amount > 0);
  assert.match(replies.at(-1), /ثبت شد/);
  const resume = s.db.prepare("select job_id from jobs where goal='chat.resume_price'").get();
  assert.ok(resume);
  assert.equal(s.db.prepare('select count(*) n from price_samples').get().n, 1);

  const events = [];
  const job = s.queue.get(resume.job_id);
  const res = await handleJob(
    { db: s.db, queue: s.queue, llm: mockLlm(), gate: s.gate, mutations: s.mutations, getAllowLiveAutoSend: () => true, onEvent: (t, p) => events.push([t, p]) },
    job
  );
  assert.equal(res.ok, true);
  assert.equal(res.result.action, 'auto_sent');
  const sendJob = s.db.prepare("select payload_json from jobs where goal='messages.send'").get();
  assert.ok(sendJob);
  assert.ok(events.some((e) => e[0] === 'chat.price_resumed'));
});

test('owner types amount («۲۸ میلیون») → stored and resumed', async () => {
  const s = autoSetup();
  await s.c.processInboundCard(noBudgetCard());
  const flows = createRoomFlows({ db: s.db, queue: s.queue, api: null, llm: null, menuOpts: () => ({}), gate: s.gate, mutations: s.mutations });
  const replies = [];
  const ctx = { from: { id: 7 }, reply: async (t) => replies.push(t), message: { text: '' } };
  await flows.startPriceEntry(ctx, '31');
  ctx.message.text = 'نمی‌دانم';
  assert.equal(await flows.maybeHandleAwaitingPrice(ctx), true);
  assert.match(replies.at(-1), /متوجه نشدم/);
  ctx.message.text = '۲۸ میلیون';
  assert.equal(await flows.maybeHandleAwaitingPrice(ctx), true);
  assert.equal(getRoomPriceAnswer(s.db, '31').amount, 28_000_000);
  assert.equal(await flows.maybeHandleAwaitingPrice(ctx), false);
});

test('worker learns the price actually sent', async () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const rs = createRoomState(db);
  rs.setCard('50', { roomId: '50', messages: [{ text: ASK, isOwn: false }] });
  const job = queue.create({ goal: 'messages.send', requiresApproval: true, payload: { roomId: '50', text: 'هزینه حدود ۲۲ میلیون تومان است.' } });
  queue.decideApproval(queue.getApprovalForJob(job.jobId).approval_id, { approve: true, decidedBy: 't' });
  const events = [];
  await handleJob({ db, queue, api: { messages: { send: async () => ({ ok: true }) } }, onEvent: (t, p) => events.push([t, p]) }, queue.get(job.jobId));
  const row = db.prepare('select amount_toman, source from price_samples').get();
  assert.equal(row.amount_toman, 22_000_000);
  assert.equal(row.source, 'sent');
  assert.equal(events.find((e) => e[0] === 'message.sent')[1].price, 22_000_000);
});

test('price card keyboard + callbacks + «بر اساس N قیمت قبلی»', () => {
  const kb = roomPriceKeyboard('31').inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(kb.includes('room:pok:31'));
  assert.ok(kb.includes('room:pset:31'));
  assert.equal(parseRoomCallback('room:pok:31').type, 'room_price_ok');
  assert.equal(parseRoomCallback('room:pset:31').type, 'room_price_set');
  const lines = formatPriceAskLines({ suggestedFa: '۲۰ میلیون تومان', basedOnN: 3 }).join('\n');
  assert.match(lines, /بر اساس ۳ قیمت قبلی/);
  assert.doesNotMatch(lines, /[\u2014\u2013]/);
  const card = formatRoomCard({ roomId: '1', guestName: 'x', suggestedPriceFa: '۱۰ تومان', priceBasedOnN: 6, messages: [] });
  assert.match(card, /بر اساس ۶ قیمت قبلی/);
});

test('production worker receives the PermissionGate (full-auto needs it)', () => {
  const src = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const worker = createWorker({'), src.indexOf('const worker = createWorker({') + 200);
  assert.match(block, /\n\s+gate,\n/);
});
