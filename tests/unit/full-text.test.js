/**
 * Item 1: full text (no description truncation; safe splitting) + full-context price card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitTelegramText, TELEGRAM_SAFE_MAX } from '../../src/telegram/split-text.js';
import { formatOpportunityDetails } from '../../src/telegram/opportunity-ux.js';
import { formatRoomCard, formatRoomMessagesView, formatPriceAskCard } from '../../src/telegram/room-card.js';
import { createRoomFlows } from '../../src/telegram/room-flows.js';
import { openDb } from '../../src/memory/db.js';
import { createRoomState } from '../../src/agent/room-state.js';
import { priceReasonFa } from '../../src/agent/chat-price.js';

const para = 'این یک پاراگراف طولانی از شرح پروژه است که باید کامل نمایش داده شود و بریده نشود. ';
const LONG = Array.from({ length: 120 }, (_, i) => `${i + 1}. ${para}`).join('\n');

test('splitTelegramText keeps everything, respects the limit, numbers parts', () => {
  const parts = splitTelegramText(LONG);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= TELEGRAM_SAFE_MAX, `len ${p.length}`);
  const joined = parts.map((p) => p.replace(/\n\n\([۰-۹]+ از [۰-۹]+\)$/, '')).join('\n');
  for (let i = 1; i <= 120; i++) assert.ok(joined.includes(`${i}. `), `missing line ${i}`);
  assert.match(parts[0], /\(۱ از [۰-۹]+\)$/);
  assert.deepEqual(splitTelegramText('کوتاه'), ['کوتاه']);
});

test('splitTelegramText never cuts inside an HTML tag, entity or surrogate pair', () => {
  const unit = 'متن <b>پررنگ</b> &amp; 😀 ';
  const s = unit.repeat(600);
  const parts = splitTelegramText(s, { max: 500, numbered: false });
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), s.replace(/\s+/g, ' ').trim());
  for (const p of parts) {
    assert.ok(p.lastIndexOf('<') <= p.lastIndexOf('>'), 'open tag at end');
    assert.doesNotMatch(p, /&[a-z]*$/);
    const c = p.charCodeAt(p.length - 1);
    assert.ok(!(c >= 0xd800 && c <= 0xdbff), 'split surrogate');
  }
});

test('opportunity details show the COMPLETE description (HTML stripped)', () => {
  const t = formatOpportunityDetails({ opportunity: { id: 5, title: 'پروژه', description: `<p>${LONG}</p>` }, score: 70 });
  assert.ok(t.includes('120. '));
  assert.ok(!t.includes('<p>'));
});

test('room card and messages view are not truncated; messages view has full text + description', () => {
  const longMsg = para.repeat(10);
  const card = {
    roomId: '1',
    guestName: 'x',
    project: { title: 'پ', description: LONG },
    messages: [{ id: '1', text: longMsg, isOwn: false }],
  };
  const view = formatRoomMessagesView(card);
  assert.ok(view.includes(longMsg.trim()));
  assert.ok(view.includes('120. '));
  const big = formatRoomCard({ ...card, analysisSummary: 'x', messages: Array.from({ length: 5 }, () => ({ text: longMsg })) });
  assert.ok(!big.endsWith('\n…'));
});

test('room flows split long views into sequential messages; buttons on the last one', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-')), 't.sqlite'));
  const rs = createRoomState(db);
  rs.setCard('9', { roomId: '9', guestName: 'x', project: { title: 't', description: LONG }, messages: [] });
  const flows = createRoomFlows({ db, queue: null, api: null, llm: null, menuOpts: () => ({}) });
  const sent = [];
  const ctx = { from: { id: 1 }, reply: async (t, o) => sent.push({ t, o }) };
  await flows.replyRoomMessages(ctx, '9');
  assert.ok(sent.length > 1);
  assert.ok(!sent[0].o?.reply_markup);
  assert.ok(sent.at(-1).o?.reply_markup);
  assert.ok(sent.map((x) => x.t).join('\n').includes('120. '));
});

test('price card carries full project context, client requests, scope and why', () => {
  const card = {
    roomId: '3',
    guestName: 'سارا',
    continuumAction: 'price_ask',
    project: { title: 'فروشگاه وردپرس', description: LONG, skills: ['وردپرس', 'ووکامرس'], category: 'طراحی سایت' },
    analysisDetail: { summary: 'فروشگاه با درگاه', requirements: ['۵۰ محصول', 'درگاه پرداخت'], complexity: 'medium', estimatedDays: 20 },
    messages: [{ text: 'قیمت چقدر است؟', isOwn: false }],
    draftText: 'سلام، انجام می‌دهم.',
    priceAsk: { suggestedFa: '۱۲٬۰۰۰٬۰۰۰ تومان', basedOnN: 4, tier: 'medium', reasonFa: priceReasonFa({ source: 'learned_uncertain', basedOnN: 4 }), range: { low: 9e6, high: 15e6 } },
  };
  const t = formatPriceAskCard(card);
  for (const re of [/فروشگاه وردپرس/, /کارفرما بودجه مشخص نکرده/, /طراحی سایت/, /ووکامرس/, /120\. /, /درگاه پرداخت/, /حجم کار: متوسط/, /سختی: متوسط/, /۲۰ روز/, /بر اساس ۴ کار مشابه/, /بازهٔ مناسب/, /پیش‌نویس پاسخ/]) {
    assert.match(t, re);
  }
  assert.equal(formatRoomCard(card), t);
  assert.doesNotMatch(t, /[\u2014\u2013]/);
  assert.match(formatPriceAskCard({ ...card, project: { ...card.project, minBudget: 1e6, maxBudget: 2e6 } }), /بودجه: .* تا .* تومان/);
  assert.match(priceReasonFa({ source: 'pricing_rules' }), /قواعد قیمت‌گذاری/);
});
