import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatScanSummary,
  truncatePreview,
  formatStatusCard,
  formatWelcome,
  afterScanInlineKeyboard,
} from '../../src/telegram/ui.js';

test('truncatePreview truncates and redacts bearer tokens', () => {
  assert.equal(truncatePreview('short'), 'short');
  const long = 'x'.repeat(100);
  assert.ok(truncatePreview(long, 20).endsWith('…'));
  assert.ok(truncatePreview(long, 20).length <= 20);
  assert.match(truncatePreview('Bearer abcdefghijklmnop hello'), /\[REDACTED\]/);
});

test('formatScanSummary Persian card with priority rooms', () => {
  const text = formatScanSummary({
    page: 1,
    total: 1016,
    lastPage: 102,
    pageCount: 10,
    unreadOnPage: 1,
    matchedCount: 0,
    scannedAt: new Date().toISOString(),
    priorityRooms: [
      {
        guest_name: 'Ardeshir.A',
        roomId: '7241431',
        unread: 1,
        last_message: 'لطفا ایمیل را استخراج کنید و تماس تمام‌وقت',
      },
      {
        guest_name: 'Other',
        roomId: '1',
        unread: 0,
        last_message: 'سلام',
      },
    ],
  });
  assert.match(text, /خلاصه اسکن/);
  assert.match(text, /1016/);
  assert.match(text, /1\/102/);
  assert.match(text, /خوانده‌نشده: 1/);
  assert.match(text, /Ardeshir\.A/);
  assert.match(text, /7241431/);
  assert.match(text, /هشدارها یا تأییدها/);
  assert.doesNotMatch(text, /Bearer /);
});

test('formatScanSummary empty priority still hints next action', () => {
  const text = formatScanSummary({ page: 2, total: 0, pageCount: 0, unreadOnPage: 0, priorityRooms: [] });
  assert.match(text, /اولویتی|آرام/);
  assert.match(text, /هشدارها یا تأییدها/);
});

test('formatStatusCard shows کارلنسر متصل/قطع and last scan', () => {
  const connected = formatStatusCard({
    state: 'running',
    karlancerAuth: true,
    lastScanAt: new Date().toISOString(),
    lastScanUnread: 1,
    queued: 0,
    running: 0,
    waitingApproval: 0,
    pendingApprovals: 0,
    pollOk: true,
  });
  assert.match(connected, /کارلنسر: ✅ متصل/);
  assert.match(connected, /آخرین اسکن/);
  assert.match(connected, /خوانده‌نشده اسکن: 1/);
  assert.match(connected, /سیستم سالم/);

  const cut = formatStatusCard({ karlancerAuth: false });
  assert.match(cut, /کارلنسر: ❌ قطع/);
});

test('formatWelcome includes karlancer line', () => {
  assert.match(formatWelcome({ karlancerAuth: true }), /کارلنسر: متصل/);
  assert.match(formatWelcome({ karlancerAuth: false }), /کارلنسر: قطع/);
});

test('afterScanInlineKeyboard has approvals + status + home', () => {
  const kb = afterScanInlineKeyboard();
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('goto:approvals'));
  assert.ok(data.includes('refresh:status'));
  assert.ok(data.includes('nav:home'));
});
