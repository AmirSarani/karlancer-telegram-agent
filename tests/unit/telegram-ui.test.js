import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BTN,
  BOT_COMMANDS,
  mainMenuKeyboard,
  approvalActionKeyboard,
  statusInlineKeyboard,
  afterScanInlineKeyboard,
  parseCallbackData,
  formatStatusCard,
  formatApprovalsList,
  formatHelp,
  formatWelcome,
  formatScanQueued,
  formatDecideResult,
  mapMenuText,
  formatAgeFa,
  approvalTarget,
} from '../../src/telegram/ui.js';

test('main menu keyboard has Persian labels and is persistent/resized', () => {
  const kb = mainMenuKeyboard('running');
  assert.equal(kb.resize_keyboard, true);
  assert.equal(kb.is_persistent, true);
  const flat = kb.keyboard.flat().map((b) => b.text);
  assert.deepEqual(flat, [BTN.STATUS, BTN.APPROVALS, BTN.SCAN, BTN.PAUSE, BTN.HELP]);

  const paused = mainMenuKeyboard('paused');
  const flatP = paused.keyboard.flat().map((b) => b.text);
  assert.ok(flatP.includes(BTN.RESUME));
  assert.ok(!flatP.includes(BTN.PAUSE));
});

test('inline approval keyboard encodes callback with id', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const kb = approvalActionKeyboard(id);
  const row = kb.inline_keyboard[0];
  assert.equal(row[0].callback_data, `ok:${id}`);
  assert.equal(row[1].callback_data, `no:${id}`);
  assert.ok(row[0].callback_data.length <= 64);
});

test('status inline shows approvals link only when pending > 0', () => {
  const empty = statusInlineKeyboard({ pendingCount: 0 });
  assert.equal(empty.inline_keyboard.length, 1);
  assert.equal(empty.inline_keyboard[0][0].callback_data, 'refresh:status');

  const withPending = statusInlineKeyboard({ pendingCount: 3 });
  assert.equal(withPending.inline_keyboard.length, 2);
  assert.equal(withPending.inline_keyboard[1][0].callback_data, 'goto:approvals');
  assert.match(withPending.inline_keyboard[1][0].text, /3/);
});

test('afterScan inline has status callback', () => {
  const kb = afterScanInlineKeyboard();
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'refresh:status');
});

test('parseCallbackData covers approve/reject/refresh/goto', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(parseCallbackData(`ok:${id}`), { type: 'approve', approvalId: id });
  assert.deepEqual(parseCallbackData(`no:${id}`), { type: 'reject', approvalId: id });
  assert.deepEqual(parseCallbackData('refresh:status'), { type: 'refresh_status' });
  assert.deepEqual(parseCallbackData('goto:approvals'), { type: 'goto_approvals' });
  assert.equal(parseCallbackData('evil:payload'), null);
  assert.equal(parseCallbackData(''), null);
  assert.equal(parseCallbackData(null), null);
});

test('mapMenuText maps reply labels', () => {
  assert.equal(mapMenuText(BTN.STATUS), 'status');
  assert.equal(mapMenuText(BTN.APPROVALS), 'approvals');
  assert.equal(mapMenuText(BTN.SCAN), 'scan');
  assert.equal(mapMenuText(BTN.PAUSE), 'pause');
  assert.equal(mapMenuText(BTN.RESUME), 'resume');
  assert.equal(mapMenuText(BTN.HELP), 'help');
  assert.equal(mapMenuText('/status'), null);
  assert.equal(mapMenuText('random'), null);
});

test('formatStatusCard is Persian and redacts secrets in lastError', () => {
  const text = formatStatusCard({
    state: 'running',
    pendingApprovals: 2,
    queued: 1,
    running: 0,
    waitingApproval: 2,
    karlancerAuth: true,
    db: 'up',
    worker: 'idle',
    lastError: 'Bearer abcdefghijklmnop secret',
  });
  assert.match(text, /وضعیت ایجنت/);
  assert.match(text, /احراز هویت کارلنسر: بله/);
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(text, /abcdefghijklmnop/);
});

test('formatApprovalsList empty and non-empty', () => {
  const empty = formatApprovalsList([]);
  assert.match(empty.text, /تأییدی در صف نیست/);
  assert.equal(empty.keyboards.length, 0);

  const id = '123e4567-e89b-12d3-a456-426614174000';
  const list = formatApprovalsList([
    {
      approval_id: id,
      action: 'bids.submit',
      created_at: new Date(Date.now() - 120_000).toISOString(),
      payload_json: JSON.stringify({ projectId: 42 }),
    },
  ]);
  assert.match(list.text, /bids\.submit/);
  assert.match(list.text, /42/);
  assert.equal(list.keyboards.length, 1);
  assert.equal(list.keyboards[0].inline_keyboard[0][0].callback_data, `ok:${id}`);
});

test('approvalTarget extracts projectId safely', () => {
  const t = approvalTarget({
    action: 'messages.send',
    payload_json: JSON.stringify({ roomId: 'r9', access_token: 'SECRET' }),
  });
  assert.equal(t.action, 'messages.send');
  assert.equal(t.target, 'r9');
});

test('help mentions buttons before slash commands', () => {
  const h = formatHelp();
  const btnIdx = h.indexOf('دکمه‌های منو');
  const slashIdx = h.indexOf('دستورات پیشرفته');
  assert.ok(btnIdx >= 0 && slashIdx > btnIdx);
  assert.match(formatWelcome(), /منوی پایین/);
  assert.match(formatScanQueued('abcdefgh-ijkl'), /اسکن/);
  assert.match(formatDecideResult({ approve: true, approvalId: 'abcdefgh', jobStatus: 'queued' }), /تأیید شد/);
});

test('formatAgeFa and BOT_COMMANDS', () => {
  assert.equal(formatAgeFa(new Date().toISOString()), 'همین الان');
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'status'));
  assert.ok(BOT_COMMANDS.every((c) => typeof c.description === 'string' && c.description.length > 0));
});
