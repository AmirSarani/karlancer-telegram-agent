import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BTN,
  BOT_COMMANDS,
  mainMenuKeyboard,
  homeInlineKeyboard,
  statusInlineKeyboard,
  systemDetailsKeyboard,
  settingsInlineKeyboard,
  approvalActionKeyboard,
  parseCallbackData,
  formatWelcome,
  formatStatusCard,
  formatSystemDetails,
  formatHelp,
  formatSettingsCard,
  formatApprovalsList,
  formatLoading,
  mapMenuText,
  actionLabelFa,
} from '../../src/telegram/ui.js';
import {
  formatRoomsList,
  formatRoomCard,
  formatRoomTechDetails,
  formatSendConfirmPreview,
  roomsListKeyboard,
  roomCardKeyboard,
} from '../../src/telegram/room-card.js';
import {
  formatScanLoading,
  formatScanAlreadyRunning,
  priorityBadge,
  formatScanSummary,
} from '../../src/telegram/scan-ux.js';

test('main nav is 6 ops items with مهم‌ها not هشدارها', () => {
  const labels = mainMenuKeyboard().keyboard.flat().map((b) => b.text);
  assert.deepEqual(labels, [
    BTN.DASHBOARD,
    BTN.CHATS,
    BTN.ALERTS,
    BTN.APPROVALS,
    BTN.SETTINGS,
    BTN.HELP,
  ]);
  assert.match(BTN.ALERTS, /مهم/);
  assert.equal(mapMenuText('هشدارها'), 'alerts');
  assert.equal(mapMenuText(BTN.ALERTS), 'alerts');
});

test('home welcome is branded with status CTAs and no secrets', () => {
  const text = formatWelcome({
    karlancerAuth: true,
    pendingApprovals: 2,
    lastScanAt: new Date().toISOString(),
  });
  assert.match(text, /کارلنسر|مرکز عملیات/);
  assert.match(text, /سیستم/);
  assert.match(text, /احراز/);
  assert.match(text, /کارلنسر: متصل/);
  assert.doesNotMatch(text, /token|Bearer|SECRET/i);
  const home = homeInlineKeyboard().inline_keyboard;
  for (const row of home) assert.ok(row.length <= 2);
  const data = home.flat().map((b) => b.callback_data);
  assert.ok(data.includes('nav:dash'));
  assert.ok(data.includes('goto:chats'));
  assert.ok(data.includes('goto:unread'));
  assert.ok(data.includes('goto:approvals'));
  assert.ok(data.includes('nav:set'));
});

test('dashboard hides technical dump; details screen has it', () => {
  const main = formatStatusCard({
    state: 'running',
    karlancerAuth: true,
    pollOk: true,
    pendingApprovals: 1,
    importantChats: 4,
    newMessages: 2,
    queued: 3,
    db: 'up',
    worker: 'idle',
    lastScanAt: new Date().toISOString(),
  });
  assert.match(main, /سیستم سالم/);
  assert.match(main, /گفتگوهای مهم/);
  assert.match(main, /پیام جدید/);
  assert.match(main, /تأیید باز/);
  assert.doesNotMatch(main, /\bworker\b|openai|playwright|دیتابیس/i);
  const details = formatSystemDetails({
    queued: 3,
    running: 0,
    waitingApproval: 1,
    pendingApprovals: 1,
    db: 'up',
    worker: 'idle',
    pollOk: true,
  });
  assert.match(details, /جزئیات سیستم/);
  assert.match(details, /صف کار/);
  assert.ok(
    systemDetailsKeyboard()
      .inline_keyboard.flat()
      .some((b) => b.callback_data === 'nav:dash')
  );
  assert.deepEqual(parseCallbackData('dash:details'), { type: 'dash_details' });
});

test('conversation list cards hide Room # and expose view/ai/note', () => {
  const rooms = [
    {
      id: 99,
      guestName: 'کارفرما',
      unread: 2,
      lastMessage: 'لطفاً وضعیت پروژه را بگویید فوری',
      projectTitle: 'استخراج داده',
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
    },
  ];
  const list = formatRoomsList(rooms, { title: '💬 گفتگوها' });
  assert.doesNotMatch(list.text, /#99|Room #/);
  assert.match(list.text, /کارفرما/);
  assert.match(list.text, /استخراج داده/);
  assert.match(list.text, /مهم|بررسی|اطلاعاتی/);
  const data = list.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('room:open:99'));
  assert.ok(data.includes('room:ai:99'));
  assert.ok(data.includes('room:dft:99'));
  for (const row of list.keyboard.inline_keyboard) assert.ok(row.length <= 2);
});

test('conversation detail User View hides Room ID; tech details keep it', () => {
  const card = {
    roomId: 7241431,
    guestName: 'Ali',
    unread: 1,
    project: { title: 'پروژه تست', id: '1' },
    messages: [{ text: 'سلام', isOwn: false }],
    draftText: 'پاسخ',
    sendApiLive: false,
  };
  const text = formatRoomCard(card);
  assert.doesNotMatch(text, /گفتگو #7241431/);
  assert.doesNotMatch(text, /7241431/);
  assert.doesNotMatch(text, /blocked_by_missing_api/);
  assert.match(text, /آخرین پیام/);
  assert.match(text, /پروژه تست/);
  const tech = formatRoomTechDetails(card);
  assert.match(tech, /شناسه گفتگو: 7241431/);
  const kb = roomCardKeyboard(7241431);
  for (const row of kb.inline_keyboard) assert.ok(row.length <= 2);
  assert.ok(kb.inline_keyboard.flat().some((b) => b.callback_data === 'room:done:7241431'));
  assert.ok(kb.inline_keyboard.flat().some((b) => b.callback_data === 'room:dft:7241431'));
  assert.ok(kb.inline_keyboard.flat().some((b) => b.callback_data === 'room:tch:7241431'));
});

test('priority badges never bare white circle', () => {
  assert.match(priorityBadge({ unread: 1 }).line, /🔥 مهم/);
  assert.match(priorityBadge({ matched: true, unread: 0 }).line, /🟡|🔥/);
  assert.match(priorityBadge({}).line, /🔵 اطلاعاتی/);
  const summary = formatScanSummary({
    pageCount: 2,
    unreadOnPage: 0,
    scannedAt: new Date().toISOString(),
    priorityRooms: [{ guest_name: 'X', roomId: '1', unread: 0, last_message: 'hi' }],
  });
  assert.doesNotMatch(summary, /⚪/);
});

test('approvals confirm copy is professional', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const { text, keyboards } = formatApprovalsList([
    {
      approval_id: id,
      action: 'messages.send',
      created_at: new Date().toISOString(),
      payload_json: JSON.stringify({ roomId: 'r1', text: 'سلام کارفرما' }),
    },
  ]);
  assert.match(text, /عملیات: ارسال پیام/);
  assert.match(text, /مقصد: r1/);
  assert.match(text, /سلام کارفرما/);
  assert.equal(actionLabelFa('bids.submit'), 'ثبت پیشنهاد');
  const kb = approvalActionKeyboard(id);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes(`ok:${id}`));
  assert.ok(data.includes(`no:${id}`));
  for (const row of kb.inline_keyboard) assert.ok(row.length <= 2);
  assert.equal(keyboards.length, 1);
});

test('settings and help are user-language without Mutation jargon', () => {
  assert.match(formatSettingsCard({ state: 'running' }), /عملیات نیازمند تأیید/);
  assert.doesNotMatch(formatHelp(), /Mutation|Candidate|Job ID/i);
  assert.match(formatHelp(), /نقشه|صفحه/);
  for (const row of settingsInlineKeyboard('running').inline_keyboard) {
    assert.ok(row.length <= 2);
  }
});

test('loading never exposes job uuid; commands include help/settings', () => {
  assert.doesNotMatch(formatScanLoading({ jobId: 'deadbeef-1234' }), /job:/i);
  assert.doesNotMatch(formatScanAlreadyRunning({ jobId: 'deadbeef-1234' }), /job:/i);
  assert.match(formatLoading('status'), /داشبورد/);
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'help'));
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'settings'));
});

test('send confirm remains honest and confirm-before-send', () => {
  const text = formatSendConfirmPreview({
    roomId: 5,
    guestName: 'کارفرما',
    draftText: 'متن پیشنهادی',
    sendApiLive: false,
  });
  assert.match(text, /عملیات: ارسال پیام/);
  assert.match(text, /مقصد/);
  assert.match(text, /blocked_by_missing_api/);
  assert.match(text, /متن پیشنهادی/);
});
