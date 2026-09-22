import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createAgentSettingsStore } from '../../src/telegram/agent-settings.js';
import {
  parseCallbackData,
  formatSettingsCard,
  formatTogglesCard,
  formatToggleConfirmCard,
  formatChatAiModeCard,
  formatModeCard,
  lockLineFa,
  togglesInlineKeyboard,
  toggleConfirmKeyboard,
  modeInlineKeyboard,
  chatAiModeInlineKeyboard,
} from '../../src/telegram/ui.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-ux-'));
  return openDb(path.join(dir, 't.sqlite'));
}

test('settings card reflects persisted chatAiMode (not always full_manual)', () => {
  const card = formatSettingsCard({
    state: 'running',
    executionMode: 'assisted',
    chatAiMode: 'full_auto',
    toggles: { autoReplyMessages: false },
  });
  assert.match(card, /حالت AI گفتگو:.*خودکار/);
  assert.doesNotMatch(card, /حالت AI گفتگو:.*کاملاً دستی/);
});

test('message lock stays locked in assisted even if switch ON — shows amber hint', () => {
  const card = formatSettingsCard({
    state: 'running',
    executionMode: 'assisted',
    chatAiMode: 'full_manual',
    toggles: { autoReplyMessages: true, autoSubmitBids: false, autoMarkNotificationsRead: false },
  });
  assert.match(card, /پیام:.*سوئیچ روشن/);
  assert.match(card, /قفل مؤثر|خودکار/);
  assert.doesNotMatch(card, /پیام: 🟢 خودکار \(باز\)/);
});

test('message lock opens only when mode=auto AND toggle ON', () => {
  const locked = formatSettingsCard({
    executionMode: 'auto',
    toggles: { autoReplyMessages: false },
  });
  assert.match(locked, /پیام: 🔒 قفل/);

  const open = formatSettingsCard({
    executionMode: 'auto',
    toggles: { autoReplyMessages: true },
  });
  assert.match(open, /پیام: 🟢 خودکار \(باز\)/);
});

test('notif-read effective in assisted when toggle ON', () => {
  const card = formatSettingsCard({
    executionMode: 'assisted',
    toggles: { autoMarkNotificationsRead: true },
  });
  assert.match(card, /خواندن اعلان: 🟢 خودکار \(باز\)/);
});

test('toggle confirm callbacks parse', () => {
  assert.deepEqual(parseCallbackData('tog:reply:on'), {
    type: 'toggle_confirm',
    name: 'autoReplyMessages',
    alsoModeAuto: false,
  });
  assert.deepEqual(parseCallbackData('tog:reply:on+'), {
    type: 'toggle_confirm',
    name: 'autoReplyMessages',
    alsoModeAuto: true,
  });
  assert.deepEqual(parseCallbackData('tog:bid:on+'), {
    type: 'toggle_confirm',
    name: 'autoSubmitBids',
    alsoModeAuto: true,
  });
  assert.equal(parseCallbackData('tog:reply').type, 'toggle');
});

test('toggle confirm keyboard + card Persian copy', () => {
  const kb = toggleConfirmKeyboard('autoReplyMessages', { offerModeAuto: true });
  const flat = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.includes('tog:reply:on'));
  assert.ok(flat.includes('tog:reply:on+'));
  assert.ok(flat.includes('nav:toggles'));
  const card = formatToggleConfirmCard('autoReplyMessages', { executionMode: 'assisted' });
  assert.match(card, /تأیید باز کردن/);
  assert.match(card, /کمکی/);
});

test('toggles keyboard shows effective status; mode keyboard links to toggles', () => {
  const kb = togglesInlineKeyboard(
    { autoReplyMessages: true, autoSubmitBids: false, autoMarkNotificationsRead: true },
    { mode: 'assisted' }
  );
  const labels = kb.inline_keyboard.flat().map((b) => b.text).join(' | ');
  assert.match(labels, /مؤثر ❌/);
  assert.match(labels, /خواندن اعلان:.*مؤثر ✅/);
  const modeKb = modeInlineKeyboard('assisted');
  assert.ok(modeKb.inline_keyboard.flat().some((b) => b.callback_data === 'nav:toggles'));
  const chatKb = chatAiModeInlineKeyboard('full_auto');
  assert.ok(chatKb.inline_keyboard.flat().some((b) => b.callback_data === 'nav:toggles'));
});

test('formatChatAiModeCard distinguishes AI mode from execution unlock', () => {
  const card = formatChatAiModeCard({
    chatAiMode: 'full_auto',
    executionMode: 'assisted',
    toggles: { autoReplyMessages: false },
  });
  assert.match(card, /جدا از/);
  assert.match(card, /باید خودکار شود|حالت اجرا/);
  assert.match(card, /سوئیچ پیام/);
});

test('formatModeCard warns mode alone does not unlock switches', () => {
  const card = formatModeCard({ executionMode: 'auto', toggles: {} });
  assert.match(card, /به‌تنهایی سوئیچ/);
});

test('lockLineFa helper', () => {
  assert.match(lockLineFa({ effective: true }), /باز/);
  assert.match(lockLineFa({ toggleOn: true, needMode: 'خودکار' }), /سوئیچ روشن/);
  assert.match(lockLineFa({}), /قفل/);
});

test('store: setChatAiMode persists and settings card input would show it', () => {
  const db = tmpDb();
  const store = createAgentSettingsStore(db);
  store.setMode('assisted');
  store.setChatAiMode('pick_to_answer');
  store.setToggle('autoReplyMessages', true);
  const s = store.get();
  const card = formatSettingsCard({
    state: 'running',
    executionMode: s.mode,
    chatAiMode: s.chatAiMode,
    toggles: s.toggles,
  });
  assert.match(card, /انتخابی/);
  assert.match(card, /پیام:.*سوئیچ روشن/);
});

test('formatTogglesCard effective lines', () => {
  const card = formatTogglesCard({
    mode: 'assisted',
    toggles: { autoReplyMessages: true, autoSubmitBids: false, autoMarkNotificationsRead: true },
  });
  assert.match(card, /پاسخ پیام:.*مؤثر: ❌ قفل/);
  assert.match(card, /خواندن اعلان:.*مؤثر: ✅ باز/);
  assert.match(card, /ALLOW_LIVE_AUTO_SEND/);
});
