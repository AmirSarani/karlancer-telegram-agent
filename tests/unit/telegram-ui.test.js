import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BTN,
  BOT_COMMANDS,
  mainMenuKeyboard,
  approvalActionKeyboard,
  statusInlineKeyboard,
  afterScanInlineKeyboard,
  settingsInlineKeyboard,
  homeInlineKeyboard,
  parseCallbackData,
  formatStatusCard,
  formatApprovalsList,
  formatHelp,
  formatWelcome,
  formatSettingsCard,
  formatSystemDetails,
  systemDetailsKeyboard,
  formatScanQueued,
  formatDecideResult,
  formatLoading,
  formatComplete,
  friendlyErrorText,
  formatFriendlyError,
  mapMenuText,
  formatAgeFa,
  approvalTarget,
  actionLabelFa,
  deriveSystemHealth,
} from '../../src/telegram/ui.js';

test('main menu includes فرصت‌ها and صندوق and is persistent', () => {
  const kb = mainMenuKeyboard('running');
  assert.equal(kb.resize_keyboard, true);
  assert.equal(kb.is_persistent, true);
  const flat = kb.keyboard.flat().map((b) => b.text);
  assert.ok(flat.includes(BTN.DASHBOARD));
  assert.ok(flat.includes(BTN.OPPORTUNITIES));
  assert.ok(flat.includes(BTN.INBOX));
  assert.ok(flat.includes(BTN.APPROVALS));
  assert.ok(flat.includes(BTN.SETTINGS));
  assert.ok(flat.length >= 6 && flat.length <= 10);
});

test('inline approval keyboard encodes callback with id and nav', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const kb = approvalActionKeyboard(id);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes(`ok:${id}`));
  assert.ok(data.includes(`no:${id}`));
  assert.ok(data.includes('nav:home'));
  for (const d of data) assert.ok(d.length <= 64);
});

test('status inline shows approvals link only when pending > 0', () => {
  const empty = statusInlineKeyboard({ pendingCount: 0 });
  const data0 = empty.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data0.includes('refresh:status'));
  assert.ok(data0.includes('nav:home'));
  assert.ok(data0.includes('dash:details'));
  assert.ok(!data0.includes('goto:approvals'));
  for (const row of empty.inline_keyboard) assert.ok(row.length <= 2);

  const withPending = statusInlineKeyboard({ pendingCount: 3 });
  const data = withPending.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('goto:approvals'));
});

test('afterScan / settings / home keyboards navigate', () => {
  const after = afterScanInlineKeyboard({ pageCount: 1, priorityRooms: [] }).inline_keyboard
    .flat()
    .map((b) => b.callback_data);
  assert.ok(after.includes('scan:refresh') || after.includes('scan:details') || after.includes('scan:chats'));
  assert.ok(after.includes('nav:home'));

  const setRunKb = settingsInlineKeyboard('running');
  const setRun = setRunKb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(setRun.includes('set:pause'));
  assert.ok(setRun.includes('set:scan'));
  for (const row of setRunKb.inline_keyboard) assert.ok(row.length <= 2);

  const setPause = settingsInlineKeyboard('paused').inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(setPause.includes('set:resume'));

  const home = homeInlineKeyboard().inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(home.includes('nav:dash'));
  assert.ok(home.includes('nav:set'));
});

test('parseCallbackData covers approve/reject/nav/settings/pagination', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(parseCallbackData(`ok:${id}`), { type: 'approve', approvalId: id });
  assert.deepEqual(parseCallbackData(`no:${id}`), { type: 'reject', approvalId: id });
  assert.deepEqual(parseCallbackData('refresh:status'), { type: 'refresh_status' });
  assert.deepEqual(parseCallbackData('goto:approvals'), { type: 'goto_approvals' });
  assert.deepEqual(parseCallbackData('goto:chats'), { type: 'goto_chats' });
  assert.deepEqual(parseCallbackData('nav:home'), { type: 'nav_home' });
  assert.deepEqual(parseCallbackData('nav:set'), { type: 'nav_settings' });
  assert.deepEqual(parseCallbackData('dash:details'), { type: 'dash_details' });
  assert.deepEqual(parseCallbackData('set:scan'), { type: 'set_scan' });
  assert.deepEqual(parseCallbackData('mode:auto'), { type: 'set_mode', mode: 'auto' });
  assert.deepEqual(parseCallbackData('set:emerg'), { type: 'set_emergency' });
  assert.deepEqual(parseCallbackData('nav:rules'), { type: 'nav_rules' });
  assert.deepEqual(parseCallbackData('tog:reply'), { type: 'toggle', name: 'autoReplyMessages' });
  assert.deepEqual(parseCallbackData('scan:refresh'), { type: 'scan_refresh' });
  assert.deepEqual(parseCallbackData('scan:details'), { type: 'scan_details' });
  assert.deepEqual(parseCallbackData('page:chats:2'), { type: 'page_chats', page: 2 });
  assert.deepEqual(parseCallbackData('page:unrd:1'), { type: 'page_unread', page: 1 });
  assert.deepEqual(parseCallbackData('room:open:7241431'), { type: 'room_open', roomId: '7241431' });
  assert.deepEqual(parseCallbackData('room:cfm:9'), { type: 'room_confirm_send', roomId: '9' });
  assert.equal(parseCallbackData('evil:payload'), null);
  assert.equal(parseCallbackData(''), null);
  assert.equal(parseCallbackData(null), null);
});

test('mapMenuText maps new IA and legacy labels', () => {
  assert.equal(mapMenuText(BTN.DASHBOARD), 'dashboard');
  assert.equal(mapMenuText(BTN.STATUS), 'dashboard');
  assert.equal(mapMenuText(BTN.CHATS), 'chats');
  assert.equal(mapMenuText(BTN.CHATS_LEGACY), 'chats');
  assert.equal(mapMenuText(BTN.ALERTS), 'alerts');
  assert.equal(mapMenuText(BTN.UNREAD), 'alerts');
  assert.equal(mapMenuText(BTN.ALERTS_LEGACY), 'alerts');
  assert.equal(mapMenuText(BTN.APPROVALS), 'approvals');
  assert.equal(mapMenuText(BTN.SETTINGS), 'settings');
  assert.equal(mapMenuText(BTN.HELP), 'help');
  assert.equal(mapMenuText(BTN.SCAN), 'scan');
  assert.equal(mapMenuText('/status'), null);
  assert.equal(mapMenuText('random'), null);
});

test('formatStatusCard is System Healthy style and redacts secrets', () => {
  const text = formatStatusCard({
    state: 'running',
    pendingApprovals: 2,
    queued: 1,
    running: 0,
    waitingApproval: 2,
    karlancerAuth: true,
    pollOk: true,
    db: 'up',
    worker: 'idle',
    lastScanUnread: 1,
    importantChats: 3,
    lastError: 'Bearer abcdefghijklmnop secret',
  });
  assert.match(text, /داشبورد عملیات/);
  assert.match(text, /سیستم سالم|هشدار/);
  assert.match(text, /کارلنسر: ✅ متصل/);
  assert.match(text, /گفتگوهای مهم/);
  assert.match(text, /پیام جدید/);
  assert.match(text, /تأیید باز/);
  assert.doesNotMatch(text, /abcdefghijklmnop/);
  assert.doesNotMatch(text, /Bearer/i);
  assert.doesNotMatch(text, /\bworker\b|دیتابیس|openai|playwright/i);
  assert.match(text, /توجه|خطا/);
  const details = formatSystemDetails({
    queued: 1,
    running: 0,
    waitingApproval: 2,
    pendingApprovals: 2,
    db: 'up',
    worker: 'idle',
    pollOk: true,
  });
  assert.match(details, /جزئیات سیستم/);
  assert.match(details, /صف کار/);
  assert.ok(systemDetailsKeyboard().inline_keyboard.flat().some((b) => b.callback_data === 'nav:dash'));
  assert.equal(deriveSystemHealth({ karlancerAuth: true, pollOk: true, state: 'running' }), 'healthy');
  assert.equal(deriveSystemHealth({ karlancerAuth: false }), 'down');
});

test('formatApprovalsList empty and non-empty', () => {
  const empty = formatApprovalsList([]);
  assert.match(empty.text, /صف تأیید خالی/);
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
  assert.match(list.text, /ثبت پیشنهاد|bids/);
  assert.match(list.text, /42/);
  assert.equal(actionLabelFa('messages.send'), 'ارسال پیام');
  assert.equal(list.keyboards.length, 1);
});

test('approvalTarget extracts projectId safely', () => {
  const t = approvalTarget({
    action: 'messages.send',
    payload_json: JSON.stringify({ roomId: 'r9', access_token: 'SECRET' }),
  });
  assert.equal(t.action, 'messages.send');
  assert.equal(t.target, 'r9');
});

test('help / welcome / settings / loading / friendly errors', () => {
  const h = formatHelp();
  assert.match(h, /نقشه|صفحه/);
  assert.match(h, /داشبورد/);
  assert.doesNotMatch(h, /Mutation/i);
  assert.match(formatWelcome({ karlancerAuth: true }), /مرکز عملیات|داشبورد|کارلنسر: متصل/);
  assert.match(formatSettingsCard({ state: 'paused' }), /مکث/);
  assert.match(formatSettingsCard({ state: 'running', karlancerAuth: true }), /حالت اجرا|دستی|قفل/);
  assert.doesNotMatch(formatSettingsCard({ state: 'running' }), /Mutation|Endpoint/i);
  assert.match(formatScanQueued('abcdefgh-ijkl'), /اسکن|صف/);
  assert.match(formatDecideResult({ approve: true, approvalId: 'abcdefgh', jobStatus: 'queued' }), /تأیید شد/);
  assert.match(formatLoading('ai'), /تحلیل/);
  assert.match(formatComplete('send'), /تأیید ثبت شد|✅/);
  assert.match(friendlyErrorText(new Error('AxiosError: timeout of 5000ms exceeded')), /طولانی|تلاش/);
  assert.doesNotMatch(friendlyErrorText('Bearer SECRETTOKEN123'), /SECRETTOKEN123/);
  const fe = formatFriendlyError('network fail', { retryCallback: 'goto:chats' });
  assert.match(fe.text, /خطا|مشکل|ارتباط/);
  assert.ok(fe.keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'goto:chats'));
});

test('formatAgeFa and BOT_COMMANDS match IA', () => {
  assert.equal(formatAgeFa(new Date().toISOString()), 'همین الان');
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'status'));
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'settings'));
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'help'));
  assert.ok(BOT_COMMANDS.some((c) => /داشبورد|سلامت|خانه/.test(c.description)));
  assert.ok(BOT_COMMANDS.every((c) => typeof c.description === 'string' && c.description.length > 0));
});
