import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRoomCard,
  roomCardKeyboard,
  roomConfirmKeyboard,
  roomsListKeyboard,
  parseRoomCallback,
  formatRoomsList,
  formatSendConfirmPreview,
  formatAiAnalysisCard,
  extractProposalHints,
} from '../../src/telegram/room-card.js';
import { parseCallbackData } from '../../src/telegram/ui.js';

test('roomCardKeyboard has AI/note/approve/reject/back/home under 64 bytes', () => {
  const kb = roomCardKeyboard(7241431);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('room:ok:7241431'));
  assert.ok(data.includes('room:no:7241431'));
  assert.ok(data.includes('room:note:7241431'));
  assert.ok(data.includes('room:ref:7241431'));
  assert.ok(data.includes('room:ai:7241431'));
  assert.ok(data.includes('goto:chats'));
  assert.ok(data.includes('nav:home'));
  for (const d of data) assert.ok(d.length <= 64);
});

test('roomConfirmKeyboard confirm/cancel', () => {
  const kb = roomConfirmKeyboard(9);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('room:cfm:9'));
  assert.ok(data.includes('room:ccl:9'));
});

test('parseRoomCallback includes cfm/ccl', () => {
  assert.deepEqual(parseRoomCallback('room:open:7241431'), { type: 'room_open', roomId: '7241431' });
  assert.deepEqual(parseCallbackData('room:ok:9'), { type: 'room_approve', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:cfm:9'), { type: 'room_confirm_send', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:ccl:9'), { type: 'room_cancel_confirm', roomId: '9' });
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

test('formatRoomsList empty, pagination, and keyboard', () => {
  const empty = formatRoomsList([]);
  assert.match(empty.text, /گفتگویی|نمایش نیست|اسکن/);
  assert.ok(empty.keyboard);

  const rooms = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    guestName: `User${i + 1}`,
    unread: i % 2,
    lastMessage: 'hi',
  }));
  const page1 = formatRoomsList(rooms, { page: 1, pageSize: 5 });
  assert.equal(page1.pageRooms.length, 5);
  assert.equal(page1.totalPages, 3);
  assert.match(page1.text, /صفحه 1\/3/);
  const data = page1.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.some((d) => d.startsWith('room:open:')));
  assert.ok(data.includes('page:chats:2'));
  assert.ok(data.includes('nav:home'));

  const unreadEmpty = formatRoomsList([], { title: '🔔 هشدارها', unreadOnly: true });
  assert.match(unreadEmpty.text, /خوانده‌نشده|عالی/);
});

test('formatSendConfirmPreview is honest about blocked api', () => {
  const text = formatSendConfirmPreview({
    roomId: 1,
    guestName: 'A',
    draftText: 'سلام',
    sendApiLive: false,
  });
  assert.match(text, /تأیید نهایی/);
  assert.match(text, /blocked_by_missing_api/);
  assert.match(text, /سلام/);
});

test('formatAiAnalysisCard has risk/intent/action/reason', () => {
  const text = formatAiAnalysisCard(
    {
      ok: true,
      summary: 'پروژه سوال قیمت دارد',
      data: {
        risk: 'متوسط',
        intent: 'درخواست قیمت',
        suggestedAction: 'پاسخ کوتاه بفرستید',
        reason: 'کارفرما بودجه پرسیده',
      },
    },
    { roomId: 5, draftUpdated: true }
  );
  assert.match(text, /ریسک/);
  assert.match(text, /نیت/);
  assert.match(text, /اقدام پیشنهادی/);
  assert.match(text, /دلیل/);
  assert.match(text, /پیش‌نویس/);
});

test('roomsListKeyboard pagination callbacks short', () => {
  const kb = roomsListKeyboard([{ id: 1, guestName: 'Ali', unread: 1 }], {
    page: 1,
    totalPages: 2,
    unreadOnly: true,
  });
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('page:unrd:2'));
  for (const d of data) assert.ok(d.length <= 64);
});

test('extractProposalHints persian price/days', () => {
  const h = extractProposalHints('مدت انجام: 3 روز، هزینه پیشنهاد: ۳,۰۰۰,۰۰۰ تومان');
  assert.equal(h.days, 3);
  assert.equal(h.price, 3000000);
});
