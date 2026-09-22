import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRoomCard,
  formatRoomTechDetails,
  formatRoomMessagesView,
  formatDraftScreen,
  formatLastMessagesBlock,
  roomCardKeyboard,
  roomDraftKeyboard,
  roomConfirmKeyboard,
  roomsListKeyboard,
  parseRoomCallback,
  formatRoomsList,
  formatSendConfirmPreview,
  formatAiAnalysisCard,
  extractProposalHints,
} from '../../src/telegram/room-card.js';
import { parseCallbackData } from '../../src/telegram/ui.js';

test('roomCardKeyboard has view/analyze/draft/send/rule under 64 bytes', () => {
  const kb = roomCardKeyboard(7241431);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('room:msg:7241431'));
  assert.ok(data.includes('room:ai:7241431'));
  assert.ok(data.includes('room:dft:7241431'));
  assert.ok(data.includes('room:snd:7241431'));
  assert.ok(data.includes('room:rule:7241431'));
  assert.ok(data.includes('room:tch:7241431'));
  assert.ok(data.includes('room:ref:7241431'));
  assert.ok(data.includes('room:done:7241431'));
  assert.ok(data.includes('goto:chats'));
  assert.ok(data.includes('nav:home'));
  // Approve lives on draft screen, not main user card
  assert.ok(!data.includes('room:ok:7241431'));
  for (const d of data) assert.ok(d.length <= 64);
  for (const row of kb.inline_keyboard) assert.ok(row.length <= 2);
});

test('roomDraftKeyboard has edit/regen/approve/cancel', () => {
  const kb = roomDraftKeyboard(9);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('room:note:9'));
  assert.ok(data.includes('room:rgn:9'));
  assert.ok(data.includes('room:ok:9'));
  assert.ok(data.includes('room:open:9'));
  for (const row of kb.inline_keyboard) assert.ok(row.length <= 2);
});

test('roomConfirmKeyboard confirm/cancel', () => {
  const kb = roomConfirmKeyboard(9);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('room:cfm:9'));
  assert.ok(data.includes('room:ccl:9'));
});

test('parseRoomCallback includes new msg/dft/tch/rgn', () => {
  assert.deepEqual(parseRoomCallback('room:open:7241431'), { type: 'room_open', roomId: '7241431' });
  assert.deepEqual(parseCallbackData('room:ok:9'), { type: 'room_approve', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:cfm:9'), { type: 'room_confirm_send', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:ccl:9'), { type: 'room_cancel_confirm', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:msg:9'), { type: 'room_messages', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:dft:9'), { type: 'room_draft', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:tch:9'), { type: 'room_tech', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:rgn:9'), { type: 'room_regen', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:snd:9'), { type: 'room_send', roomId: '9' });
  assert.deepEqual(parseCallbackData('room:rule:9'), { type: 'room_auto_rule', roomId: '9' });
  assert.equal(parseRoomCallback('evil'), null);
});

test('formatRoomCard User View hides ids/slugs/api; shows human project card', () => {
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
    projectSlug: 'extract-email',
    messages: [{ text: 'سلام', isOwn: false }, { text: '[?] چشم', isOwn: true }],
    draftText: 'پیش‌نویس تست Bearer SECRETTOKEN123',
    sendApiLive: false,
  });
  assert.doesNotMatch(text, /7241431/);
  assert.doesNotMatch(text, /327343/);
  assert.doesNotMatch(text, /extract-email|اسلاگ|اسلاگ/);
  assert.doesNotMatch(text, /blocked_by_missing_api/);
  assert.doesNotMatch(text, /SECRETTOKEN123/);
  assert.doesNotMatch(text, /\[\?\]/);
  assert.match(text, /استخراج ایمیل/);
  assert.match(text, /بودجه/);
  assert.match(text, /کارفرما/);
  assert.match(text, /شما/);
  assert.match(text, /پیش‌نویس/);
  assert.match(text, /REDACTED/);
});

test('formatRoomTechDetails holds ids and send path honesty', () => {
  const text = formatRoomTechDetails({
    roomId: 7241431,
    project: { id: '327343' },
    projectSlug: 'extract-email',
    sendApiLive: false,
  });
  assert.match(text, /شناسه گفتگو: 7241431/);
  assert.match(text, /327343/);
  assert.match(text, /extract-email/);
  assert.match(text, /blocked|غیرفعال/);
});

test('formatLastMessagesBlock and messages view are friendly', () => {
  const block = formatLastMessagesBlock(
    [
      { text: '[?] سلام', isOwn: false },
      { text: 'در خدمتم', isOwn: true },
    ],
    { max: 5 }
  );
  assert.match(block, /آخرین پیام/);
  assert.match(block, /کارفرما/);
  assert.match(block, /شما/);
  assert.doesNotMatch(block, /\[\?\]/);

  const view = formatRoomMessagesView({
    guestName: 'Ali',
    messages: [{ text: 'hi', isOwn: false }],
  });
  assert.match(view, /پیام/);
  assert.match(view, /Ali/);
});

test('formatDraftScreen shows ready status', () => {
  const text = formatDraftScreen({
    guestName: 'کارفرما',
    draftText: 'سلام، آماده‌ام کمک کنم.',
  });
  assert.match(text, /پیش‌نویس پاسخ/);
  assert.match(text, /آماده بررسی/);
  assert.match(text, /سلام/);
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
  assert.match(page1.text, /صفحه (1|۱)\/(3|۳)/);
  const data = page1.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.some((d) => d.startsWith('room:open:')));
  assert.ok(data.some((d) => d.startsWith('room:ai:')));
  assert.ok(data.some((d) => d.startsWith('room:dft:')));
  assert.ok(data.includes('page:chats:2'));
  assert.ok(data.includes('nav:home'));
  assert.doesNotMatch(page1.text, /#1\b/);
  for (const row of page1.keyboard.inline_keyboard) assert.ok(row.length <= 2);

  const unreadEmpty = formatRoomsList([], { title: '🔥 مهم‌ها', unreadOnly: true });
  assert.match(unreadEmpty.text, /مهم|خوانده‌نشده|عالی/);
});

test('formatSendConfirmPreview is honest about blocked api', () => {
  const text = formatSendConfirmPreview({
    roomId: 1,
    guestName: 'A',
    draftText: 'سلام',
    sendApiLive: false,
  });
  assert.match(text, /تأیید/);
  assert.match(text, /blocked_by_missing_api/);
  assert.match(text, /عملیات|مقصد|پیش‌نمایش/);
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
