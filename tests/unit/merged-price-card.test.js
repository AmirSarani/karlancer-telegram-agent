/**
 * Item 4: one merged price card; after the owner sets a price the same card is edited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import {
  savePriceCardMessages,
  getPriceCardMessages,
  addPriceCardMessage,
  clearPriceCardMessages,
} from '../../src/telegram/price-card-store.js';
import { formatRoomCard, formatResumedPriceCard } from '../../src/telegram/room-card.js';

const tmpDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'item4-')), 't.sqlite'));

test('price card store: save deliveries, add the pressed message, clear', () => {
  const db = tmpDb();
  savePriceCardMessages(db, 'r1', [{ chatId: 1, messageIds: [10, 11] }, { chatId: 2, messageIds: [20] }]);
  assert.equal(getPriceCardMessages(db, 'r1').length, 2);
  addPriceCardMessage(db, 'r1', 1, 11); // already tracked
  assert.deepEqual(getPriceCardMessages(db, 'r1')[0].messageIds, [10, 11]);
  addPriceCardMessage(db, 'r1', 3, 30); // another owner chat
  assert.equal(getPriceCardMessages(db, 'r1').length, 3);
  clearPriceCardMessages(db, 'r1');
  assert.equal(getPriceCardMessages(db, 'r1').length, 0);
});

test('merged card: price question + project context + draft preview in ONE text', () => {
  const card = {
    roomId: 'r1',
    continuumAction: 'price_ask',
    project: { title: 'طراحی لوگو', description: 'یک لوگوی ساده برای فروشگاه', minBudget: 1_000_000, maxBudget: 3_000_000 },
    draftText: 'سلام، ممنون از پیامتان. برای این کار آماده‌ام.',
    priceAsk: { suggested: 2_000_000, suggestedFa: '۲ میلیون تومان', tier: 'small', range: { low: 1_000_000, high: 3_000_000 }, reasonFa: 'بر اساس بودجه' },
    messages: [{ id: '1', text: 'سلام، لوگو می‌خواهم', isOwn: false }],
  };
  const t = formatRoomCard(card);
  assert.match(t, /طراحی لوگو/);
  assert.match(t, /یک لوگوی ساده/);
  assert.match(t, /ممنون از پیامتان/);
});

test('resumed card: same card becomes final draft for approval; auto-sent → short line', () => {
  const t = formatResumedPriceCard({
    roomId: 'r1',
    continuumAction: 'auto_hitl',
    suggestedPrice: 2_000_000,
    suggestedPriceFa: '۲ میلیون تومان',
    draftText: 'سلام، هزینه ۲ میلیون تومان است.',
    project: { title: 'طراحی لوگو' },
    priceAsk: { suggested: 2_000_000 },
  });
  assert.match(t, /پیش‌نویس نهایی/);
  assert.match(t, /هزینه ۲ میلیون/);
  assert.doesNotMatch(t.split('\n')[0], /[—–]/);
  const a = formatResumedPriceCard({ roomId: 'r1', continuumAction: 'auto_sent', suggestedPriceFa: '۲ میلیون تومان' });
  assert.match(a, /ارسال شد/);
});
