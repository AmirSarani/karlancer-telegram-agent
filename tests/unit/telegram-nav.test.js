import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mainMenuKeyboard,
  parseCallbackData,
  formatApprovalsList,
  BTN,
} from '../../src/telegram/ui.js';
import { formatRoomsList, roomConfirmKeyboard, formatAiAnalysisCard } from '../../src/telegram/room-card.js';

test('IA menu labels are Persian and max 6', () => {
  const labels = mainMenuKeyboard().keyboard.flat().map((b) => b.text);
  assert.equal(labels.length, 6);
  for (const l of labels) {
    assert.equal(typeof l, 'string');
    assert.ok(l.length > 0);
  }
  assert.ok(labels.includes(BTN.DASHBOARD));
  assert.ok(labels.includes(BTN.SETTINGS));
});

test('empty approvals and empty chats are friendly FA', () => {
  assert.match(formatApprovalsList([]).text, /خالی|نیست/);
  assert.match(formatRoomsList([], { unreadOnly: false }).text, /نیست|اسکن/);
  assert.match(formatRoomsList([], { unreadOnly: true }).text, /خوانده‌نشده|عالی/);
});

test('confirm keyboard and AI fallback card', () => {
  const cfm = roomConfirmKeyboard('abc').inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(parseCallbackData(cfm[0]), { type: 'room_confirm_send', roomId: 'abc' });
  const ai = formatAiAnalysisCard({ ok: false, summary: 'تحلیل AI در دسترس نیست' }, { roomId: 1 });
  assert.match(ai, /ریسک/);
  assert.match(ai, /نیت/);
  assert.match(ai, /اقدام پیشنهادی/);
  assert.match(ai, /دلیل/);
});
