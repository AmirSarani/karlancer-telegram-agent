import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRoomCard,
  roomCardKeyboard,
  parseRoomCallback,
  formatRoomsList,
  extractProposalHints,
} from '../../src/telegram/room-card.js';
import { parseCallbackData } from '../../src/telegram/ui.js';

test('roomCardKeyboard has approve/reject/note/refresh/ai', () => {
  const kb = roomCardKeyboard(7241431);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('room:ok:7241431'));
  assert.ok(data.includes('room:no:7241431'));
  assert.ok(data.includes('room:note:7241431'));
  assert.ok(data.includes('room:ref:7241431'));
  assert.ok(data.includes('room:ai:7241431'));
  for (const d of data) assert.ok(d.length <= 64);
});

test('parseRoomCallback and ui parseCallbackData', () => {
  assert.deepEqual(parseRoomCallback('room:open:7241431'), { type: 'room_open', roomId: '7241431' });
  assert.deepEqual(parseCallbackData('room:ok:9'), { type: 'room_approve', roomId: '9' });
  assert.equal(parseRoomCallback('evil'), null);
});

test('formatRoomCard includes project budget and draft; redacts bearer', () => {
  const text = formatRoomCard({
    roomId: 7241431,
    guestName: 'کارفرما',
    unread: 1,
    project: {
      id: '327343',
      title: 'استخراج ایمیل',
      minBudget: 300000,
      maxBudget: 1500000,
      jobDuration: 5,
      isFulltime: true,
    },
    messages: [{ text: 'سلام', isOwn: false }],
    draftText: 'پیش‌نویس تست Bearer SECRETTOKEN123',
    sendApiLive: false,
  });
  assert.match(text, /7241431/);
  assert.match(text, /استخراج ایمیل/);
  assert.match(text, /بودجه/);
  assert.match(text, /تمام‌وقت/);
  assert.match(text, /پیش‌نویس/);
  assert.match(text, /blocked_by_missing_api/);
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(text, /SECRETTOKEN123/);
});

test('formatRoomsList empty and with items', () => {
  const empty = formatRoomsList([]);
  assert.match(empty.text, /اتاقی/);
  const list = formatRoomsList([
    { id: 1, guestName: 'A', unread: 2, lastMessage: 'hi' },
  ]);
  assert.match(list.text, /چت/);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].keyboard.inline_keyboard[0][0].callback_data, 'room:open:1');
});

test('extractProposalHints persian price/days', () => {
  const h = extractProposalHints('مدت انجام: 3 روز، هزینه پیشنهاد: ۳,۰۰۰,۰۰۰ تومان');
  assert.equal(h.days, 3);
  assert.equal(h.price, 3000000);
});
