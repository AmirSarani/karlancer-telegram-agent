import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_STATES,
  toFaNum,
  truncatePersianText,
  formatRelativeTime,
  priorityReasonLabel,
  priorityBadge,
  deriveScanState,
  formatScanSummary,
  formatScanDetails,
  formatScanPriorityList,
  formatScanUnreadList,
  formatScanRoomCard,
  formatScanLoading,
  formatScanAlreadyRunning,
  formatScanError,
  formatScanQueued,
  buildScanKeyboard,
  afterScanInlineKeyboard,
  buildScanDetailsKeyboard,
  buildScanPriorityKeyboard,
  buildScanUnreadKeyboard,
  buildScanRoomKeyboard,
  parseScanCallback,
  findActiveScanJob,
  buildScanResultMessage,
} from '../../src/telegram/scan-ux.js';

const samplePriority = {
  page: 1,
  total: 1016,
  lastPage: 102,
  pageCount: 10,
  unreadOnPage: 1,
  matchedCount: 2,
  scannedAt: new Date().toISOString(),
  priorityRooms: [
    {
      guest_name: 'Ardeshir.A',
      roomId: '7241431',
      unread: 1,
      last_message: 'لطفا ایمیل را استخراج کنید و تماس تمام‌وقت برقرار نمایید فوری',
      reason: 'پیام جدید',
    },
    {
      guest_name: 'Other',
      roomId: '1',
      unread: 0,
      last_message: 'سلام',
    },
  ],
};

test('A: toFaNum converts digits for UI only', () => {
  assert.equal(toFaNum(12), '۱۲');
  assert.equal(toFaNum('7241431'), '۷۲۴۱۴۳۱');
  assert.equal(toFaNum(null), '—');
});

test('B: truncatePersianText is word-aware and redacts secrets', () => {
  const long = 'این یک پیام طولانی برای تست برش آگاه به کلمه در متن فارسی است و باید نقطه امن پیدا کند';
  const out = truncatePersianText(long, { max: 40, lines: 2 });
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 41);
  assert.match(truncatePersianText('Bearer abcdefghijklmnop hello'), /\[REDACTED\]/);
});

test('C: success_with_priority summary hides page ratio and room ids', () => {
  const text = formatScanSummary(samplePriority);
  assert.match(text, /اسکن کارلنسر|نتیجه اسکن|خلاصه اسکن/);
  assert.doesNotMatch(text, /1\/102|۱\/۱۰۲/);
  assert.doesNotMatch(text, /7241431/);
  assert.match(text, /Ardeshir\.A/);
  assert.match(text, /پیام جدید|خوانده/);
  assert.match(text, /نیازمند بررسی/);
  assert.match(text, /اولویت/);
  assert.doesNotMatch(text, /🔑 تطابق کلیدواژه/);
  assert.equal(deriveScanState(samplePriority), SCAN_STATES.success_with_priority);
  // mini-dashboard + up to 3 priority cards
  assert.ok(text.split('\n').length <= 24);
});

test('D: details screen shows page and totals', () => {
  const text = formatScanDetails(samplePriority);
  assert.match(text, /جزئیات/);
  assert.match(text, /۱۰۱۶|1016/);
  assert.match(text, /۱ از ۱۰۲|1 از 102/);
});

test('E: empty success is calm Persian copy', () => {
  const text = formatScanSummary({
    page: 1,
    total: 0,
    pageCount: 0,
    unreadOnPage: 0,
    priorityRooms: [],
    scannedAt: new Date().toISOString(),
  });
  assert.equal(deriveScanState({
    pageCount: 0,
    unreadOnPage: 0,
    priorityRooms: [],
    scannedAt: new Date().toISOString(),
  }), SCAN_STATES.success_empty);
  assert.doesNotMatch(text, /No candidates|کاندید/i);
  assert.match(text, /آرام|پیدا نشد|نیازمند/);
});

test('F: loading and already_running states', () => {
  const loading = formatScanLoading({ jobId: 'abcdefgh-1' });
  assert.match(loading, /اسکن|صبر|بررسی/);
  assert.doesNotMatch(loading, /job:/i);
  const running = formatScanAlreadyRunning({ jobId: 'abcdefgh-1' });
  assert.match(running, /در حال|موازی|صبر/);
  assert.doesNotMatch(running, /job:/i);
  assert.match(formatScanQueued('abcdefgh-1'), /اسکن|بررسی/);
  assert.equal(deriveScanState({ loading: true }), SCAN_STATES.loading);
  assert.equal(deriveScanState({ alreadyRunning: true }), SCAN_STATES.already_running);
});

test('G: error has no axios/stack and offers retry keyboard', () => {
  const err = formatScanError({
    errorText: 'اتصال طولانی شد. کمی بعد دوباره تلاش کنید.',
  });
  assert.doesNotMatch(err.text, /Axios|at Object\.|Error:/i);
  const data = err.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('scan:refresh'));
  assert.ok(data.includes('nav:home'));
});

test('H: partial success warns without dropping available results', () => {
  const text = formatScanSummary({ ...samplePriority, softFailCount: 2, partial: true });
  assert.equal(deriveScanState({ ...samplePriority, softFailCount: 2 }), SCAN_STATES.partial_success);
  assert.match(text, /کامل|ناقص|بررسی نشد/);
  assert.match(text, /Ardeshir/);
});

test('I: priority reason uses real reason or conservative label', () => {
  assert.equal(priorityReasonLabel({ reason: 'تطابق کلیدواژه' }), 'تطابق کلیدواژه');
  assert.equal(priorityReasonLabel({ unread: 1 }), 'پیام جدید');
  assert.match(priorityReasonLabel({}), /اولویت|بررسی|انتخاب/);
  assert.match(priorityBadge({ unread: 1 }).line, /🔥/);
  assert.match(priorityBadge({ matched: true }).line, /🟡|🔥/);
  assert.match(priorityBadge({}).line, /🔵/);
  assert.notEqual(priorityBadge({}).emoji, '⚪');
});

test('J: keyboards max 2 buttons/row and scan callbacks parse', () => {
  const kb = buildScanKeyboard(samplePriority);
  for (const row of kb.inline_keyboard) {
    assert.ok(row.length <= 2, `row too wide: ${row.length}`);
  }
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('scan:priority'));
  assert.ok(data.includes('scan:details'));
  assert.ok(data.includes('scan:refresh'));
  assert.deepEqual(parseScanCallback('scan:page:3'), { type: 'scan_page', page: 3 });
  assert.deepEqual(parseScanCallback('room:done:42'), { type: 'room_done', roomId: '42' });
  assert.equal(parseScanCallback('evil'), null);
});

test('K: afterScanInlineKeyboard aliases buildScanKeyboard', () => {
  const a = afterScanInlineKeyboard(samplePriority).inline_keyboard.flat().map((b) => b.callback_data);
  const b = buildScanKeyboard(samplePriority).inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(a, b);
});

test('L: priority/unread/room progressive disclosure', () => {
  assert.match(formatScanPriorityList(samplePriority), /اولویت|مهم/);
  assert.doesNotMatch(formatScanPriorityList(samplePriority), /⚪/);
  assert.match(formatScanUnreadList(samplePriority), /خوانده/);
  const card = formatScanRoomCard(samplePriority.priorityRooms[0], { showDetails: false });
  assert.doesNotMatch(card, /7241431/);
  const withId = formatScanRoomCard(samplePriority.priorityRooms[0], { showDetails: true });
  assert.match(withId, /7241431/);
  const roomKb = buildScanRoomKeyboard('7241431', { aiAvailable: false });
  const cbs = roomKb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!cbs.some((c) => c.startsWith('room:ai:')));
  assert.ok(cbs.includes('room:done:7241431'));
});

test('M: findActiveScanJob detects queued/running rooms.scan', () => {
  const queue = {
    list({ status }) {
      if (status === 'running') return [{ goal: 'rooms.scan', jobId: 'r1' }];
      return [];
    },
  };
  assert.equal(findActiveScanJob(queue).jobId, 'r1');
  assert.equal(findActiveScanJob({ list: () => [] }), null);
});

test('N: buildScanResultMessage packages text+keyboard', () => {
  const msg = buildScanResultMessage(samplePriority);
  assert.match(msg.text, /اسکن/);
  assert.ok(msg.reply_markup.inline_keyboard.length >= 1);
  assert.equal(msg.state, SCAN_STATES.success_with_priority);
});

test('O: summary hierarchy matches needsReview and points to مشاهده همه', () => {
  const text = formatScanSummary({
    pageCount: 10,
    unreadOnPage: 0,
    matchedCount: 1,
    scannedAt: new Date().toISOString(),
    priorityRooms: [
      { guest_name: 'Mohammad.S', roomId: '1', unread: 0, last_message: 'xss-bypass.png', reason: 'تطابق کلیدواژه' },
      { guest_name: 'Maryam.S', roomId: '2', unread: 0, last_message: 'پیشنهاد بر روی پروژه «رفع اشکال برنامه object dete' },
      { guest_name: 'A', roomId: '3', unread: 0, last_message: 'a' },
      { guest_name: 'B', roomId: '4', unread: 0, last_message: 'b' },
      { guest_name: 'C', roomId: '5', unread: 0, last_message: 'c' },
    ],
  });
  assert.match(text, /نیازمند بررسی: ۵/);
  assert.match(text, /پیام جدید: ندارید/);
  assert.match(text, /Mohammad\.S/);
  assert.match(text, /تطابق کلیدواژه/);
  assert.match(text, /📎 xss-bypass\.png/);
  assert.doesNotMatch(text, /««|»»/);
  assert.doesNotMatch(text, /برای بررسی انتخاب شده/);
  assert.doesNotMatch(text, /🔑 تطابق کلیدواژه/);
  assert.match(text, /و ۲ مورد دیگر/);
  assert.match(text, /مشاهده همه/);
  // only top 3 names on the card
  assert.doesNotMatch(text, /\bC\b/);
  const kb = buildScanKeyboard({
    pageCount: 10,
    unreadOnPage: 0,
    priorityRooms: Array.from({ length: 5 }, (_, i) => ({ guest_name: `U${i}`, roomId: String(i), unread: 0 })),
  });
  const labels = kb.inline_keyboard.flat().map((b) => b.text).join(' ');
  assert.match(labels, /مشاهده همه/);
});

test('relative time uses Persian digits', () => {
  const t = formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString());
  assert.match(t, /دقیقه/);
  assert.match(t, /[۰-۹]/);
});

test('details and priority keyboards stay ≤2 per row', () => {
  for (const kb of [
    buildScanDetailsKeyboard(samplePriority),
    buildScanPriorityKeyboard(samplePriority, { page: 1 }),
    buildScanUnreadKeyboard(samplePriority),
  ]) {
    for (const row of kb.inline_keyboard) assert.ok(row.length <= 2);
  }
});
