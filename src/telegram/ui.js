import { Keyboard, InlineKeyboard } from 'grammy';
import { redactString } from '../security/redaction.js';
import { parseRoomCallback } from './room-card.js';
import {
  formatScanSummary as formatScanSummaryUx,
  formatScanQueued as formatScanQueuedUx,
  truncatePersianText,
  afterScanInlineKeyboard as afterScanInlineKeyboardUx,
  buildScanKeyboard,
  buildScanResultMessage,
  parseScanCallback,
  findActiveScanJob,
  formatScanDetails,
  formatScanPriorityList,
  formatScanUnreadList,
  formatScanRoomCard,
  formatScanLoading,
  formatScanAlreadyRunning,
  formatScanError,
  buildScanDetailsKeyboard,
  buildScanPriorityKeyboard,
  buildScanUnreadKeyboard,
  buildScanRoomKeyboard,
  deriveScanState,
  SCAN_STATES,
  toFaNum,
  formatRelativeTime,
  priorityReasonLabel,
  priorityBadge,
} from './scan-ux.js';

export {
  truncatePersianText,
  buildScanKeyboard,
  buildScanResultMessage,
  parseScanCallback,
  findActiveScanJob,
  formatScanDetails,
  formatScanPriorityList,
  formatScanUnreadList,
  formatScanRoomCard,
  formatScanLoading,
  formatScanAlreadyRunning,
  formatScanError,
  buildScanDetailsKeyboard,
  buildScanPriorityKeyboard,
  buildScanUnreadKeyboard,
  buildScanRoomKeyboard,
  deriveScanState,
  SCAN_STATES,
  toFaNum,
  formatRelativeTime,
  priorityReasonLabel,
  priorityBadge,
};

/** Reply-keyboard button labels (exact match for hears / text map). Max 6 main items. */
export const BTN = Object.freeze({
  DASHBOARD: '📊 داشبورد',
  ANSWERED: '✅ جواب‌داده‌شده‌ها',
  CHATS: '💬 گفتگوها',
  OPPORTUNITIES: '🔥 فرصت‌ها',
  INBOX: '📥 صندوق',
  ALERTS: '🔥 مهم‌ها',
  APPROVALS: '✅ تأییدها',
  CONTROL: '🖥 کنترل سیستم',
  SETTINGS: '⚙️ تنظیمات',
  HELP: '❓ راهنما',
  // Legacy aliases (still mapped for mid-session keyboards)
  STATUS: 'وضعیت',
  UNREAD: 'خوانده‌نشده',
  ALERTS_LEGACY: 'هشدارها',
  SCAN: 'اسکن',
  PAUSE: 'مکث',
  RESUME: 'ادامه',
  CHATS_LEGACY: 'چت‌ها',
  DASHBOARD_LEGACY: 'داشبورد',
  APPROVALS_LEGACY: 'تأییدها',
  SETTINGS_LEGACY: 'تنظیمات',
  HELP_LEGACY: 'راهنما',
});

/** BotCommand list for setMyCommands (Persian) — matches new IA. */
export const BOT_COMMANDS = [
  { command: 'start', description: 'خانه — داشبورد عملیات' },
  { command: 'status', description: 'داشبورد سلامت سیستم' },
  { command: 'chats', description: 'گفتگوهای کارلنسر' },
  { command: 'unread', description: 'مهم‌ها و خوانده‌نشده' },
  { command: 'approvals', description: 'تأییدهای در انتظار' },
  { command: 'settings', description: 'تنظیمات ایجنت' },
  { command: 'control', description: 'کنترل کامل سیستم' },
  { command: 'opportunities', description: 'فرصت‌های پروژه' },
  { command: 'inbox', description: 'صندوق تصمیم' },
  { command: 'mode', description: 'نمایش/تغییر حالت اجرا' },
  { command: 'automation', description: 'خودکارسازی و محدودیت‌ها' },
  { command: 'show_rules', description: 'قوانین خودکار' },
  { command: 'emergency_stop', description: 'توقف اضطراری خودکار' },
  { command: 'scan', description: 'اسکن گفتگوها' },
  { command: 'pause', description: 'مکث موقت ایجنت' },
  { command: 'resume', description: 'ادامه کار ایجنت' },
  { command: 'help', description: 'راهنمای کوتاه' },
  { command: 'approve', description: 'تأیید پیشرفته (با شناسه)' },
  { command: 'reject', description: 'رد پیشرفته (با شناسه)' },
  { command: 'cancel', description: 'لغو جریان جاری (مثلاً نوت)' },
];

/**
 * Persistent main reply keyboard — 6 items max.
 * @param {'running'|'paused'} [agentState='running']
 */
export function mainMenuKeyboard(agentState = 'running') {
  void agentState; // pause/resume live under تنظیمات
  return new Keyboard()
    .text(BTN.DASHBOARD)
    .text(BTN.CHATS)
    .row()
    .text(BTN.OPPORTUNITIES)
    .text(BTN.INBOX)
    .row()
    .text(BTN.APPROVALS)
    .text(BTN.CONTROL)
    .row()
    .text(BTN.SETTINGS)
    .text(BTN.HELP)
    .resized()
    .persistent();
}

/**
 * Approval screen: Execute · Edit · Reject (HITL hash integrity unchanged — ok/no callbacks).
 * @param {string} approvalId
 * @param {{ editable?: boolean }} [opts]
 */
export function approvalActionKeyboard(approvalId, { editable = true } = {}) {
  const kb = new InlineKeyboard()
    .text('✅ اجرا', `ok:${approvalId}`)
    .text('❌ رد', `no:${approvalId}`);
  if (editable) {
    kb.row().text('✏️ ویرایش', `edit:${approvalId}`);
  }
  kb.row().text('⬅️ بازگشت', 'goto:approvals').text('🏠 خانه', 'nav:home');
  return kb;
}

/**
 * Shared nav row: Back / Home / Refresh where applicable.
 * @param {{ back?: string, refresh?: string, home?: boolean }} [opts]
 */
export function navRow(kb, { back = 'nav:home', refresh = null, home = true } = {}) {
  if (back) kb.text('⬅️ بازگشت', back);
  if (home) kb.text('🏠 خانه', 'nav:home');
  if (refresh) kb.text('🔄', refresh);
  return kb;
}

/**
 * @param {{ pendingCount?: number, healthy?: boolean|null }} [opts]
 */
export function statusInlineKeyboard({ pendingCount = 0 } = {}) {
  const kb = new InlineKeyboard()
    .text('🔄 بروزرسانی', 'refresh:status')
    .text('🏠 خانه', 'nav:home')
    .row()
    .text('🛠 جزئیات سیستم', 'dash:details');
  if (pendingCount > 0) {
    kb.row().text(`✅ تأییدها (${toFaNum(pendingCount)})`, 'goto:approvals');
  }
  kb.row()
    .text('💬 گفتگوها', 'goto:chats')
    .text('🔥 مهم‌ها', 'goto:unread')
    .row()
    .text('✅ جواب‌داده‌شده‌ها', 'goto:answered');
  return kb;
}

/** Keyboard for system details (technical/ops dump). */
export function systemDetailsKeyboard() {
  return new InlineKeyboard()
    .text('⬅️ بازگشت', 'nav:dash')
    .text('🏠 خانه', 'nav:home')
    .row()
    .text('🔄 بروزرسانی', 'dash:details');
}

export function afterScanInlineKeyboard(summary = {}) {
  return afterScanInlineKeyboardUx(summary);
}

/**
 * @param {'running'|'paused'} agentState
 */
/**
 * Settings hub — mode / rules / emergency (Persian, non-technical).
 * @param {'running'|'paused'} agentState
 * @param {{ mode?: string, emergencyStop?: boolean }} [exec]
 */
export function settingsInlineKeyboard(agentState = 'running', exec = {}) {
  const kb = new InlineKeyboard();
  kb.text('🟢 دستی', 'mode:manual')
    .text('🟡 کمکی', 'mode:assisted')
    .row()
    .text('🔴 خودکار', 'mode:auto')
    .text('📜 قوانین خودکار', 'nav:rules')
    .row()
    .text('🤖 حالت AI گفتگو', 'nav:chatmode')
    .text('✅ جواب‌داده‌شده‌ها', 'goto:answered')
    .row();
  if (exec.emergencyStop) {
    kb.text('▶️ رفع توقف اضطراری', 'set:emerg_clear');
  } else {
    kb.text('🛑 توقف اضطراری', 'set:emerg');
  }
  kb.row();
  if (agentState === 'paused') {
    kb.text('▶️ ادامه ایجنت', 'set:resume');
  } else {
    kb.text('⏸ مکث ایجنت', 'set:pause');
  }
  kb.row()
    .text('🖥 کنترل سیستم', 'cp:hub')
    .text('📡 اسکن اتاق‌ها', 'set:scan')
    .row()
    .text('🔥 فرصت‌ها', 'opp:hub')
    .text('📚 کتاب فرصت‌ها', 'book:home')
    .row()
    .text('👤 پروفایل امتیاز', 'opp:profile')
    .text('📥 صندوق', 'goto:inbox')
    .row()
    .text('🔐 تمدید نشست', 'set:relogin')
    .row()
    .text('🎚 سوئیچ‌ها', 'nav:toggles')
    .text('🏆 پس از برد', 'nav:postwin')
    .row()
    .text('⬅️ بازگشت', 'nav:dash')
    .text('🏠 خانه', 'nav:home')
    .row()
    .text('🔄 بروزرسانی', 'nav:set');
  return kb;
}

export function modeInlineKeyboard(current = 'manual') {
  const mark = (m) => (current === m ? '✓ ' : '');
  return new InlineKeyboard()
    .text(`${mark('manual')}🟢 دستی`, 'mode:manual')
    .text(`${mark('assisted')}🟡 کمکی`, 'mode:assisted')
    .row()
    .text(`${mark('auto')}🔴 خودکار`, 'mode:auto')
    .row()
    .text('🎚 سوئیچ‌ها (قفل پیام)', 'nav:toggles')
    .row()
    .text('⬅️ تنظیمات', 'nav:set')
    .text('🏠 خانه', 'nav:home');
}

export function togglesInlineKeyboard(toggles = {}, { mode = 'manual' } = {}) {
  const sw = (v) => (v ? '🟢 روشن' : '🔒 خاموش');
  const msgEff = Boolean(toggles.autoReplyMessages) && mode === 'auto';
  const bidEff = Boolean(toggles.autoSubmitBids) && mode === 'auto';
  const readEff = Boolean(toggles.autoMarkNotificationsRead) && mode !== 'manual';
  const eff = (ok) => (ok ? '· مؤثر ✅' : '· مؤثر ❌');
  return new InlineKeyboard()
    .text(`پیام: ${sw(toggles.autoReplyMessages)} ${eff(msgEff)}`, 'tog:reply')
    .row()
    .text(`پیشنهاد: ${sw(toggles.autoSubmitBids)} ${eff(bidEff)}`, 'tog:bid')
    .row()
    .text(`خواندن اعلان: ${sw(toggles.autoMarkNotificationsRead)} ${eff(readEff)}`, 'tog:read')
    .row()
    .text('🎛 حالت اجرا', 'nav:mode')
    .text('📜 قوانین', 'nav:rules')
    .row()
    .text('⬅️ تنظیمات', 'nav:set')
    .text('🏠 خانه', 'nav:home');
}

/** Confirm keyboard when enabling a high-risk auto toggle. */
export function toggleConfirmKeyboard(name, { offerModeAuto = false } = {}) {
  const map = {
    autoReplyMessages: { on: 'tog:reply:on', onMode: 'tog:reply:on+', cancel: 'nav:toggles' },
    autoSubmitBids: { on: 'tog:bid:on', onMode: 'tog:bid:on+', cancel: 'nav:toggles' },
  };
  const ids = map[name] || map.autoReplyMessages;
  const kb = new InlineKeyboard().text('✅ فقط سوئیچ را روشن کن', ids.on).row();
  if (offerModeAuto) {
    kb.text('✅ سوئیچ + حالت اجرا → خودکار', ids.onMode).row();
  }
  kb.text('❌ انصراف', ids.cancel).row().text('🏠 خانه', 'nav:home');
  return kb;
}

export function rulesInlineKeyboard() {
  return new InlineKeyboard()
    .text('📨 قانون پیام', 'rule:msg')
    .text('💼 قانون پیشنهاد', 'rule:bid')
    .row()
    .text('🔌 روشن/خاموش پیام', 'rule:msg:tog')
    .text('🔌 روشن/خاموش پیشنهاد', 'rule:bid:tog')
    .row()
    .text('✏️ معیار پیام خودکار', 'wiz:msg_rule')
    .text('💸 سقف تخفیف و کف قیمت', 'wiz:pricing')
    .row()
    .text('🔁 پیام پیگیری', 'wiz:followup')
    .text('🔄 یادگیری از قیمت‌های قبلی', 'wiz:price_sync')
    .row()
    .text('⬅️ تنظیمات', 'nav:set')
    .text('🏠 خانه', 'nav:home');
}

export function homeInlineKeyboard() {
  return new InlineKeyboard()
    .text('📊 داشبورد', 'nav:dash')
    .text('💬 گفتگوها', 'goto:chats')
    .row()
    .text('🔥 فرصت‌ها', 'opp:hub')
    .text('📥 صندوق', 'goto:inbox')
    .row()
    .text('🔥 مهم‌ها', 'goto:unread')
    .text('✅ تأییدها', 'goto:approvals')
    .row()
    .text('🖥 کنترل سیستم', 'cp:hub')
    .text('⚙️ تنظیمات', 'nav:set')
    .row()
    .text('❓ راهنما', 'nav:help');
}

/**
 * Parse callback_data. Returns null if unknown/invalid.
 * @param {string} data
 */
export function parseCallbackData(data) {
  if (typeof data !== 'string' || !data) return null;
  const scan = parseScanCallback(data);
  if (scan) return scan;
  // Lazy import avoids circular dependency with control-panel
  if (data.startsWith('cp:') || data.startsWith('eyes:') || data.startsWith('brain:') || data.startsWith('hands:') || data.startsWith('notif:') || data.startsWith('wiz:')) {
    if (data === 'hands:live:ask') return { type: 'hands_live_ask' };
    if (data === 'wiz:limits') return { type: 'wiz_limits' };
    if (data === 'wiz:bl_kw') return { type: 'wiz_bl_keywords' };
    if (data === 'wiz:bl_rooms') return { type: 'wiz_bl_rooms' };
    if (data === 'wiz:msg_rule') return { type: 'wiz_msg_rule' };
    if (data === 'wiz:pricing') return { type: 'wiz_pricing' };
    if (data === 'wiz:followup') return { type: 'wiz_followup' };
    if (data === 'wiz:price_sync') return { type: 'wiz_price_sync' };
    // control-panel map is applied in bot via parseControlCallback; keep aliases here too
    const cpMap = {
      'cp:hub': 'cp_hub',
      'cp:sys': 'cp_sys',
      'cp:eyes': 'cp_eyes',
      'cp:brain': 'cp_brain',
      'cp:hands': 'cp_hands',
      'cp:sec': 'cp_sec',
      'cp:notif': 'cp_notif',
      'cp:audit': 'cp_audit',
      'cp:help': 'cp_help',
      'eyes:dash': 'eyes_dash',
      'eyes:prof': 'eyes_prof',
      'eyes:notif': 'eyes_notif',
      'eyes:bm': 'eyes_bm',
      'eyes:plans': 'eyes_plans',
      'eyes:search': 'eyes_search',
      'eyes:seo': 'eyes_seo',
      'brain:hist': 'brain_hist',
      'hands:lim': 'hands_limits',
      'hands:bl': 'hands_blacklist',
      'hands:live': 'hands_live',
      'hands:live:on': 'hands_live_on',
      'hands:live:off': 'hands_live_off',
      'notif:digest': 'notif_digest',
      'notif:bale': 'notif_bale',
      'notif:bale:set': 'notif_bale_set',
      'notif:bale:clr': 'notif_bale_clear',
    };
    if (cpMap[data]) return { type: cpMap[data] };
  }
  if (data === 'refresh:status') return { type: 'refresh_status' };
  if (data === 'goto:approvals') return { type: 'goto_approvals' };
  if (data === 'goto:chats') return { type: 'goto_chats' };
  if (data === 'goto:unread') return { type: 'goto_unread' };
  if (data === 'goto:inbox') return { type: 'goto_inbox' };
  if (data === 'inbox:refresh') return { type: 'inbox_refresh' };
  if (data === 'nav:home') return { type: 'nav_home' };
  if (data === 'nav:dash') return { type: 'nav_dash' };
  if (data === 'nav:set') return { type: 'nav_settings' };
  if (data === 'nav:help') return { type: 'nav_help' };
  if (data === 'dash:details') return { type: 'dash_details' };
  if (data === 'set:pause') return { type: 'set_pause' };
  if (data === 'set:resume') return { type: 'set_resume' };
  if (data === 'set:scan') return { type: 'set_scan' };
  if (data === 'set:relogin') return { type: 'set_relogin' };
  if (data === 'set:relogin:token') return { type: 'set_relogin_token' };
  if (data === 'set:relogin:password') return { type: 'set_relogin_password' };
  if (data === 'set:relogin:cancel') return { type: 'set_relogin_cancel' };
  if (data === 'nav:postwin') return { type: 'nav_postwin' };
  if (data === 'set:emerg') return { type: 'set_emergency' };
  if (data === 'set:emerg_clear') return { type: 'set_emergency_clear' };
  if (data === 'nav:rules') return { type: 'nav_rules' };
  if (data === 'nav:chatmode') return { type: 'nav_chatmode' };
  if (data === 'goto:answered') return { type: 'goto_answered' };
  if (data === 'chatmode:full_manual' || data === 'chatmode:pick_to_answer' || data === 'chatmode:full_auto') {
    return { type: 'set_chat_ai_mode', mode: data.slice('chatmode:'.length) };
  }
  if (data === 'opp:hub') return { type: 'opp_hub' };
  if (data === 'nav:toggles') return { type: 'nav_toggles' };
  if (data === 'nav:mode') return { type: 'nav_mode' };
  if (data === 'mode:manual' || data === 'mode:assisted' || data === 'mode:auto') {
    return { type: 'set_mode', mode: data.slice(5) };
  }
  if (data === 'tog:reply') return { type: 'toggle', name: 'autoReplyMessages' };
  if (data === 'tog:bid') return { type: 'toggle', name: 'autoSubmitBids' };
  if (data === 'tog:read') return { type: 'toggle', name: 'autoMarkNotificationsRead' };
  if (data === 'tog:reply:on') return { type: 'toggle_confirm', name: 'autoReplyMessages', alsoModeAuto: false };
  if (data === 'tog:reply:on+') return { type: 'toggle_confirm', name: 'autoReplyMessages', alsoModeAuto: true };
  if (data === 'tog:bid:on') return { type: 'toggle_confirm', name: 'autoSubmitBids', alsoModeAuto: false };
  if (data === 'tog:bid:on+') return { type: 'toggle_confirm', name: 'autoSubmitBids', alsoModeAuto: true };
  if (data === 'rule:msg') return { type: 'rule_view', kind: 'message' };
  if (data === 'rule:bid') return { type: 'rule_view', kind: 'bid' };
  if (data === 'rule:msg:tog') return { type: 'rule_toggle', kind: 'message' };
  if (data === 'rule:bid:tog') return { type: 'rule_toggle', kind: 'bid' };
  const editM = /^edit:([0-9a-fA-F-]{8,36})$/.exec(data);
  if (editM) return { type: 'edit_approval', approvalId: editM[1] };

  const pageM = /^page:(chats|unrd):(\d{1,4})$/.exec(data);
  if (pageM) {
    return {
      type: pageM[1] === 'unrd' ? 'page_unread' : 'page_chats',
      page: Number(pageM[2]),
    };
  }

  const room = parseRoomCallback(data);
  if (room) return room;

  const m = /^(ok|no):([0-9a-fA-F-]{8,36})$/.exec(data);
  if (m) {
    return { type: m[1] === 'ok' ? 'approve' : 'reject', approvalId: m[2] };
  }
  return null;
}

/** @param {string|Date|null|undefined} iso */
export function formatAgeFa(iso) {
  return formatRelativeTime(iso);
}

/**
 * Safe target label from approval payload (no secrets).
 * @param {object} approval
 */
export function approvalTarget(approval) {
  let payload = {};
  try {
    payload = JSON.parse(approval.payload_json || '{}');
  } catch {
    payload = {};
  }
  const target =
    payload.projectId ||
    payload.project_id ||
    payload.roomId ||
    payload.room_id ||
    payload.targetRef ||
    payload.slug ||
    null;
  const action = approval.action || payload.goal || '—';
  const preview =
    payload.text ||
    payload.message ||
    payload.body ||
    payload.content ||
    payload.draft ||
    null;
  return {
    action: String(action),
    target: target != null ? String(target) : '—',
    preview: preview != null ? String(preview) : '',
  };
}

/** User-facing action label (avoid developer jargon). */
export function actionLabelFa(action) {
  const a = String(action || '');
  const map = {
    'messages.send': 'ارسال پیام',
    'bids.submit': 'ثبت پیشنهاد',
    'notifications.mark_read': 'خواندن اعلان',
    'messages.mark_seen': 'علامت خوانده‌شده',
    'rooms.scan': 'اسکن گفتگوها',
  };
  if (map[a]) return map[a];
  if (!a || a === '—') return 'عملیات';
  return a.replace(/[._]/g, ' ').slice(0, 40);
}

/**
 * Derive overall health for dashboard header.
 * @param {object} s
 * @returns {'healthy'|'warn'|'down'}
 */
export function deriveSystemHealth(s = {}) {
  if (s.karlancerAuth === false || s.pollOk === false || s.state === 'paused') {
    if (s.karlancerAuth === false || s.pollOk === false) return 'down';
    return 'warn';
  }
  if (s.lastError || (s.pendingApprovals ?? 0) > 5) return 'warn';
  if (s.karlancerAuth === true && s.pollOk !== false) return 'healthy';
  return 'warn';
}

function healthHeader(level) {
  if (level === 'healthy') return '🟢 سیستم سالم';
  if (level === 'down') return '🔴 نیاز به توجه';
  return '🟡 هشدار جزئی';
}

/**
 * Ops health dashboard — answers in &lt;5s. No technical dump on main.
 */
export function formatStatusCard(s = {}) {
  const health = deriveSystemHealth(s);
  const stateFa = s.state === 'paused' ? '⏸ مکث' : '▶️ فعال';
  const karlancerLine =
    s.karlancerAuth === true
      ? '✅ متصل'
      : s.karlancerAuth === false
        ? '❌ قطع'
        : '❔ نامشخص';

  const important =
    s.importantChats != null
      ? Number(s.importantChats)
      : s.pendingRooms != null
        ? Number(s.pendingRooms)
        : null;
  const newMsgs =
    s.newMessages != null
      ? Number(s.newMessages)
      : s.lastScanUnread != null
        ? Number(s.lastScanUnread)
        : null;
  const pending = Number(s.pendingApprovals ?? 0) || 0;

  const lastActivity =
    s.lastActivityAt ||
    s.lastPollAt ||
    s.lastScanAt ||
    s.lastCommandAt ||
    null;

  const lines = [
    '📊 داشبورد عملیات',
    healthHeader(health),
    '————————',
    '',
    '🖥 وضعیت',
    `• ایجنت: ${stateFa}`,
    `• کارلنسر: ${karlancerLine}`,
  ];

  if (important != null) lines.push(`• گفتگوهای مهم: ${toFaNum(important)}`);
  if (newMsgs != null) lines.push(`• پیام جدید: ${toFaNum(newMsgs)}`);
  lines.push(`• تأیید باز: ${toFaNum(pending)}`);

  if (s.executionMode || s.autoToday != null) {
    lines.push('', '🎛 اجرای خودکار');
    lines.push(`• حالت: ${modeLabelFa(s.executionMode || 'manual')}`);
    if (s.emergencyStop) lines.push('• 🛑 توقف اضطراری فعال');
    const at = s.autoToday || {};
    lines.push(
      `• امروز خودکار: پیام ${toFaNum(at.messages ?? 0)} · پیشنهاد ${toFaNum(at.bids ?? 0)}`
    );
    if (s.lastAutoAction) {
      lines.push(`• آخرین خودکار: ${String(s.lastAutoAction).slice(0, 60)}`);
    }
  }

  lines.push('', '📡 فعالیت');
  if (s.lastScanAt) lines.push(`• آخرین اسکن: ${formatAgeFa(s.lastScanAt)}`);
  else lines.push('• آخرین اسکن: —');
  if (lastActivity) lines.push(`• آخرین فعالیت: ${formatAgeFa(lastActivity)}`);

  if (s.lastError) {
    lines.push('', `⚠️ توجه: ${friendlyErrorText(s.lastError)}`);
  }

  lines.push('', 'جزئیات فنی در «جزئیات سیستم».');
  return lines.join('\n');
}

/**
 * Technical / ops dump — moved off the main dashboard.
 */
export function formatSystemDetails(s = {}) {
  const lines = [
    '🛠 جزئیات فنی',
    '————————',
    '',
    'برای عیب‌یابی — داشبورد اصلی ساده‌تر است.',
    '',
    '📦 صف کار',
    `• در انتظار: ${toFaNum(s.queued ?? 0)}`,
    `• در حال اجرا: ${toFaNum(s.running ?? 0)}`,
    `• منتظر تأیید: ${toFaNum(s.waitingApproval ?? 0)}`,
    `• تأییدهای باز: ${toFaNum(s.pendingApprovals ?? 0)}`,
    '',
    '🔌 اتصال',
  ];
  if (s.pollOk === true) lines.push('• دریافت پیام: سالم');
  else if (s.pollOk === false) lines.push('• دریافت پیام: خطا');
  else lines.push('• دریافت پیام: —');
  if (s.db) lines.push(`• پایگاه داده: ${s.db}`);
  if (s.worker) lines.push(`• پردازشگر: ${s.worker}`);
  if (s.lastPollAt) lines.push(`• آخرین دریافت: ${formatAgeFa(s.lastPollAt)}`);
  if (s.pendingRooms != null) lines.push(`• تصمیم باز: ${toFaNum(s.pendingRooms)}`);
  if (s.startedAt) lines.push(`• شروع کار: ${formatAgeFa(s.startedAt)}`);
  if (s.lastCommandAt) lines.push(`• آخرین دستور: ${formatAgeFa(s.lastCommandAt)}`);
  if (s.lastError) {
    lines.push('', `⚠️ آخرین خطا: ${friendlyErrorText(s.lastError)}`);
  }
  if (s.extra) {
    const cleaned = redactString(String(s.extra)).trim().slice(0, 200);
    if (cleaned) lines.push('', cleaned);
  }
  lines.push('', 'این صفحه برای عیب‌یابی است؛ داشبورد اصلی خلاصهٔ عملیاتی است.');
  return lines.join('\n');
}

export function modeLabelFa(mode) {
  if (mode === 'assisted') return '🟡 کمکی';
  if (mode === 'auto') return '🔴 خودکار';
  return '🟢 دستی';
}


export function chatAiModeLabelFa(mode) {
  if (mode === 'pick_to_answer') return '🟡 انتخابی';
  if (mode === 'full_auto') return '🔴 خودکار';
  return '🟢 کاملاً دستی';
}

export function formatChatAiModeCard(s = {}) {
  const mode = s.chatAiMode || 'full_manual';
  const exec = s.executionMode || s.mode || 'manual';
  const t = s.toggles || {};
  return [
    '🤖 حالت AI گفتگو',
    '————————',
    '',
    `فعلی: ${chatAiModeLabelFa(mode)}`,
    '',
    '🟢 کاملاً دستی — فقط اعلان؛ تحلیل/ارسال با دستور شما',
    '🟡 انتخابی — تحلیل+پیش‌نویس+قیمت؛ شما انتخاب می‌کنید «جواب بدم؟»',
    '🔴 خودکار — تحلیل+دروازه مجوز+سقف روزانه (هرگز نامحدود)',
    '',
    '⚠️ این تنظیم جدا از «حالت اجرا» و «سوئیچ پیام» است.',
    'برای ارسال خودکار واقعی علاوه بر AI خودکار نیاز است:',
    `• حالت اجرا: ${modeLabelFa(exec)} ${exec === 'auto' ? '✅' : '← باید خودکار شود'}`,
    `• سوئیچ پیام: ${t.autoReplyMessages ? 'روشن ✅' : 'خاموش ← از سوئیچ‌ها باز کنید'}`,
    '• قانون پیام + سقف روزانه',
    '• ALLOW_LIVE_AUTO_SEND (پیش‌فرض خاموش/امن — بدون آن فقط HITL)',
    '',
    'امنیت: توقف اضطراری، بلک‌لیست، قرارداد تأییدشده',
    s.emergencyStop ? '\n🛑 توقف اضطراری فعال است.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function chatAiModeInlineKeyboard(current = 'full_manual') {
  const mark = (m) => (current === m ? '✓ ' : '');
  return new InlineKeyboard()
    .text(`${mark('full_manual')}🟢 دستی`, 'chatmode:full_manual')
    .row()
    .text(`${mark('pick_to_answer')}🟡 انتخابی`, 'chatmode:pick_to_answer')
    .row()
    .text(`${mark('full_auto')}🔴 خودکار`, 'chatmode:full_auto')
    .row()
    .text('🎚 سوئیچ پیام', 'nav:toggles')
    .text('🎛 حالت اجرا', 'nav:mode')
    .row()
    .text('📜 قوانین AI', 'nav:rules')
    .text('✅ جواب‌داده‌شده‌ها', 'goto:answered')
    .row()
    .text('⬅️ تنظیمات', 'nav:set')
    .text('🏠 خانه', 'nav:home');
}


export function lockAutoFa(on) {
  return on ? '🟢 خودکار (باز)' : '🔒 قفل';
}

/**
 * Human lock line: switch vs effective (mode-gated).
 * @param {{ toggleOn?: boolean, effective?: boolean, needMode?: string }} opts
 */
export function lockLineFa({ toggleOn = false, effective = false, needMode = null } = {}) {
  if (effective) return '🟢 خودکار (باز)';
  if (toggleOn && needMode) {
    return `🟡 سوئیچ روشن · قفل مؤثر (حالت را «${needMode}» کنید)`;
  }
  if (toggleOn) return '🟡 سوئیچ روشن · هنوز مؤثر نیست';
  return '🔒 قفل — از «سوئیچ‌ها» باز کنید';
}

export function formatSettingsCard(s = {}) {
  const stateFa = s.state === 'paused' ? '⏸ مکث' : '▶️ فعال';
  const mode = s.executionMode || 'manual';
  const toggles = s.toggles || {};
  const authLine =
    s.karlancerAuth === true
      ? '• نشست: ✅ فعال'
      : s.karlancerAuth === false
        ? '• نشست: ❌ منقضی — «تمدید نشست» را بزنید'
        : '• نشست: ❔ نامشخص';
  const liveLine = s.liveAutoBid
    ? '• پیشنهاد زنده: ⚡ روشن'
    : '• پیشنهاد زنده: 🔒 خاموش (امن)';
  const msgOn = Boolean(toggles.autoReplyMessages);
  const bidOn = Boolean(toggles.autoSubmitBids);
  const readOn = Boolean(toggles.autoMarkNotificationsRead);
  const lines = [
    '⚙️ تنظیمات اجرا',
    '————————',
    '',
    '🎛 وضعیت',
    `• ایجنت: ${stateFa}`,
    `• حالت اجرا: ${modeLabelFa(mode)}`,
    `• حالت AI گفتگو: ${chatAiModeLabelFa(s.chatAiMode || 'full_manual')}`,
    s.emergencyStop ? '• 🛑 توقف اضطراری: فعال' : '• توقف اضطراری: خاموش',
    liveLine,
    '',
    '🔓 قفل عملیات (مؤثر)',
    `• پیام: ${lockLineFa({ toggleOn: msgOn, effective: msgOn && mode === 'auto', needMode: 'خودکار' })}`,
    `• پیشنهاد: ${lockLineFa({ toggleOn: bidOn, effective: bidOn && mode === 'auto', needMode: 'خودکار' })}`,
    `• خواندن اعلان: ${lockLineFa({ toggleOn: readOn, effective: readOn && mode !== 'manual', needMode: 'کمکی/خودکار' })}`,
    authLine,
    '',
    '📌 پیام خودکار واقعی = حالت اجرا «خودکار» + سوئیچ پیام + قانون پیام.',
    '🤖 «حالت AI گفتگو» جداست (تحلیل/پیش‌نویس) و به‌تنهایی قفل ارسال را باز نمی‌کند.',
    '💡 پیش‌فرض دستی است. خودکار فقط با قانون + سقف روزانه.',
    '🔐 تمدید نشست: توکن مرورگر بهتر از رمز در چت.',
    '🖥 برای خواندن داده / مغز / امنیت → «کنترل سیستم»',
  ];
  return lines.join('\n');
}

export function formatModeCard(s = {}) {
  const mode = s.executionMode || s.mode || 'manual';
  const t = s.toggles || {};
  return [
    '🎛 حالت اجرا',
    '————————',
    '',
    `فعلی: ${modeLabelFa(mode)}`,
    '',
    '🟢 دستی — فقط پیشنهاد؛ هر ارسال با تأیید شما',
    '🟡 کمکی — آماده‌سازی کامل؛ کار کم‌ریسک خودکار (ارسال/پیشنهاد همچنان تأیید)',
    '🔴 خودکار — قانون + سوئیچ + سقف (هرگز نامحدود)',
    '',
    '⚠️ عوض کردن حالت به‌تنهایی سوئیچ پیام/پیشنهاد را باز نمی‌کند.',
    'بعد از «خودکار»، از «سوئیچ‌ها» قفل پیام را با تأیید باز کنید.',
    t.autoReplyMessages || t.autoSubmitBids
      ? `وضعیت سوئیچ: پیام ${t.autoReplyMessages ? 'روشن' : 'خاموش'} · پیشنهاد ${t.autoSubmitBids ? 'روشن' : 'خاموش'}`
      : null,
    s.emergencyStop ? '\n🛑 توقف اضطراری فعال است.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatRulesCard(s = {}) {
  const msg = s.rules?.messageAuto || {};
  const bid = s.rules?.bidAuto || {};
  const limits = s.limits || {};
  return [
    '📜 قوانین خودکار',
    '————————',
    '',
    '📨 پیام خودکار:',
    `• وضعیت: ${msg.enabled ? 'روشن' : 'خاموش (پیش‌فرض)'}`,
    `• حداقل اطمینان هوش مصنوعی: ${msg.matchScoreThreshold != null ? `${toFaNum(msg.matchScoreThreshold)}٪` : (msg.keywords?.length || msg.budgetMin != null || msg.clientStatus) ? '—' : 'پیش‌فرض ۶۰٪'}`,
    `• کلیدواژه‌ها: ${(msg.keywords || []).join('، ') || '—'}`,
    `• حداقل بودجه: ${msg.budgetMin != null ? `${toFaNum(Number(msg.budgetMin).toLocaleString('en-US'))} تومان` : '—'}`,
    '',
    '💼 پیشنهاد خودکار:',
    `• وضعیت: ${bid.enabled ? 'روشن' : 'خاموش (پیش‌فرض)'}`,
    `• دسته: ${(bid.categoryMatch || []).join('، ') || '—'}`,
    `• آستانه بودجه: ${bid.budgetThreshold ?? '—'}`,
    `• بدون پیشنهاد قبلی: ${bid.noExistingBid !== false ? 'بله' : 'خیر'}`,
    `• اطمینان: ${bid.scoringAvailable ? (bid.confidenceThreshold ?? '—') : 'هنوز در دسترس نیست'}`,
    '',
    `🔁 پیگیری: ${s.followUp?.enabled === false ? 'خاموش' : `بعد از ${toFaNum(s.followUp?.afterHours ?? 24)} ساعت بی‌پاسخی، حداکثر ${toFaNum(s.followUp?.maxPerRoom ?? 1)} بار`}`,
    '',
    '💸 مذاکره قیمت:',
    '• قیمت هر کار: بر اساس حجم و سختی همان کار و قیمت‌های قبلی شما',
    `• سقف تخفیف: ${toFaNum(s.pricing?.maxDiscountPct ?? 10)}٪ از قیمت همان کار`,
    `• کف قیمت (اختیاری): ${s.pricing?.priceFloorToman ? `${toFaNum(Number(s.pricing.priceFloorToman).toLocaleString('en-US'))} تومان، فقط برای کارهای گران‌تر از آن` : 'خاموش'}`,
    '',
    `سقف روزانه (فقط ارسال‌های خودکار): پیام ${toFaNum(limits.maxAutoMessagesPerDay ?? 5)} · پیشنهاد ${toFaNum(limits.maxAutoBidsPerDay ?? 10)}`,
    '',
    'تا قانون روشن نشود، خودکار اجرا نمی‌شود.',
    'ویرایش پیشرفته‌تر قوانین فرصت در «مغز» است.',
  ].join('\n');
}

export function formatTogglesCard(s = {}) {
  const t = s.toggles || {};
  const mode = s.executionMode || s.mode || 'manual';
  const msgEff = Boolean(t.autoReplyMessages) && mode === 'auto';
  const bidEff = Boolean(t.autoSubmitBids) && mode === 'auto';
  const readEff = Boolean(t.autoMarkNotificationsRead) && mode !== 'manual';
  return [
    '🎚 سوئیچ‌های خودکار',
    '————————',
    '',
    `حالت اجرا فعلی: ${modeLabelFa(mode)}`,
    '',
    `• پاسخ پیام: ${t.autoReplyMessages ? '🟢 روشن' : '🔒 خاموش'} — مؤثر: ${msgEff ? '✅ باز' : '❌ قفل'}`,
    `• ثبت پیشنهاد: ${t.autoSubmitBids ? '🟢 روشن' : '🔒 خاموش'} — مؤثر: ${bidEff ? '✅ باز' : '❌ قفل'}`,
    `• خواندن اعلان: ${t.autoMarkNotificationsRead ? '🟢 روشن' : '🔒 خاموش'} — مؤثر: ${readEff ? '✅ باز' : '❌ قفل'}`,
    '',
    'برای باز شدن مؤثر پیام/پیشنهاد: حالت اجرا باید «خودکار» باشد.',
    'روشن کردن پیام/پیشنهاد نیاز به تأیید جداگانه دارد (دکمه را بزنید).',
    'حتی روشن هم بدون قانون و سقف کار نمی‌کند.',
    'ارسال زنده پیام همچنان به ALLOW_LIVE_AUTO_SEND وابسته است (پیش‌فرض خاموش/امن).',
    'پیشنهاد زنده جداگانه در «کنترل سیستم → عملیات» است.',
  ].join('\n');
}

export function formatToggleConfirmCard(name, s = {}) {
  const mode = s.executionMode || s.mode || 'manual';
  const isMsg = name === 'autoReplyMessages';
  const title = isMsg ? 'پاسخ خودکار پیام' : 'پیشنهاد خودکار';
  const needAuto = mode !== 'auto';
  return [
    `⚠️ تأیید باز کردن: ${title}`,
    '————————',
    '',
    `حالت اجرا الان: ${modeLabelFa(mode)}`,
    needAuto
      ? 'قفل مؤثر تا وقتی حالت «خودکار» نباشد باز نمی‌شود.'
      : 'حالت اجرا مناسب است — پس از تأیید، سوئیچ روشن می‌شود.',
    '',
    isMsg
      ? 'ارسال زنده واقعی همچنان به قانون پیام + سقف + ALLOW_LIVE_AUTO_SEND نیاز دارد.'
      : 'ثبت زنده پیشنهاد به قانون پیشنهاد + سقف + ALLOW_LIVE_AUTO_BID نیاز دارد.',
    '',
    'متوجهید و می‌خواهید ادامه دهید؟',
  ].join('\n');
}

export function formatEmergencyCard(active) {
  if (active) {
    return [
      '🛑 توقف اضطراری',
      '————————',
      '',
      'همهٔ ارسال/پیشنهاد خودکار خاموش شد و حالت روی دستی است.',
      'برای ادامه، «رفع توقف اضطراری» را بزنید و دوباره حالت را انتخاب کنید.',
    ].join('\n');
  }
  return [
    '🛑 توقف اضطراری',
    '————————',
    '',
    'با تأیید، همهٔ سوئیچ‌های خودکار خاموش و حالت دستی می‌شود.',
  ].join('\n');
}

/**
 * @param {object[]} pending
 * @param {{ max?: number }} [opts]
 */

export function riskLabelFa(risk) {
  if (risk === 'high') return '🔴 بالا';
  if (risk === 'medium') return '🟡 متوسط';
  if (risk === 'low') return '🟢 پایین';
  return String(risk || '—');
}

/** Pull AI reason / risk from approval payload when present. */
export function extractApprovalMeta(approval) {
  let payload = {};
  try {
    payload = JSON.parse(approval.payload_json || '{}');
  } catch {
    payload = {};
  }
  const reason =
    payload.aiReason ||
    payload.reason ||
    payload.gateReasonFa ||
    payload.analysisReason ||
    null;
  const risk = payload.risk || payload.riskLevel || null;
  return { reason: reason != null ? String(reason).slice(0, 160) : null, risk, payload };
}

/**
 * Rich approval card: Operation, Target, AI reason, Risk, Preview.
 */
export function formatApprovalDetail(approval) {
  const { action, target, preview } = approvalTarget(approval);
  const { reason, risk } = extractApprovalMeta(approval);
  const shortId = String(approval.approval_id || '').slice(0, 8);
  return [
    '✅ تأیید عملیات',
    '————————',
    '',
    `• عملیات: ${actionLabelFa(action)}`,
    `• مقصد: ${target}`,
    reason ? `• دلیل AI: ${reason}` : '• دلیل AI: —',
    `• ریسک: ${riskLabelFa(risk || (action === 'messages.send' || action === 'bids.submit' ? 'high' : 'low'))}`,
    preview ? `• پیش‌نمایش: «${truncatePersianText(preview, { max: 180, lines: 4 })}»` : '• پیش‌نمایش: —',
    `• زمان: ${formatAgeFa(approval.created_at)}`,
    `• شناسه: ${shortId}…`,
  ].join('\n');
}

export function formatApprovalsList(pending, { max = 8 } = {}) {
  if (!pending?.length) {
    return {
      text: [
        '✅ تأییدها',
        '————————',
        '',
        'صف تأیید خالی است.',
        '',
        'وقتی عملیاتی نیاز به تأیید شما داشته باشد، اینجا می‌آید.',
        'تا آن موقع می‌توانید گفتگوها یا مهم‌ها را ببینید.',
      ].join('\n'),
      keyboards: [],
    };
  }
  const slice = pending.slice(0, max);
  const blocks = [];
  const keyboards = [];
  for (let i = 0; i < slice.length; i++) {
    const a = slice[i];
    const { action, target, preview } = approvalTarget(a);
    const shortId = String(a.approval_id || '').slice(0, 8);
    const previewLine = preview
      ? `• متن: «${truncatePersianText(preview, { max: 100, lines: 2 })}»`
      : null;
    const risk = extractApprovalMeta(a).risk;
    const reason = extractApprovalMeta(a).reason;
    blocks.push(
      [
        `🧾 مورد ${toFaNum(i + 1)} از ${toFaNum(pending.length)}`,
        `• عملیات: ${actionLabelFa(action)}`,
        `• مقصد: ${target}`,
        reason ? `• دلیل AI: ${reason}` : null,
        risk ? `• ریسک: ${riskLabelFa(risk)}` : null,
        previewLine,
        `• زمان: ${formatAgeFa(a.created_at)}`,
        `• شناسه: ${shortId}…`,
      ]
        .filter(Boolean)
        .join('\n')
    );
    keyboards.push(approvalActionKeyboard(a.approval_id));
  }
  let out = ['✅ تأییدهای در انتظار', '————————', '', ...blocks].join('\n\n');
  if (pending.length > max) {
    out += `\n\n… و ${toFaNum(pending.length - max)} مورد دیگر`;
  }
  return { text: out, keyboards };
}

/**
 * @param {{ karlancerAuth?: boolean|null, lastScanAt?: string|null, pendingApprovals?: number }} [opts]
 */
export function formatWelcome(opts = {}) {
  const health = deriveSystemHealth({
    karlancerAuth: opts.karlancerAuth,
    state: opts.state,
    pollOk: opts.pollOk,
    pendingApprovals: opts.pendingApprovals,
    lastError: opts.lastError,
  });
  const systemLine =
    health === 'healthy' ? 'سیستم: 🟢 سالم' : health === 'down' ? 'سیستم: 🔴 نیاز به توجه' : 'سیستم: 🟡 هشدار';
  const authLine =
    opts.karlancerAuth === true
      ? 'احراز هویت: ✅ آماده'
      : opts.karlancerAuth === false
        ? 'احراز هویت: ❌ نیاز به بررسی'
        : 'احراز هویت: ❔ نامشخص';
  const karlancerLine =
    opts.karlancerAuth === true
      ? 'کارلنسر: متصل ✅'
      : opts.karlancerAuth === false
        ? 'کارلنسر: قطع ❌'
        : 'کارلنسر: نامشخص';
  const lines = [
    '🏠 کارلنسر — مرکز عملیات AI',
    '————————',
    '',
    'سلام 👋 به داشبورد حرفه‌ای خوش آمدید.',
    '',
    `• ${systemLine}`,
    `• ${authLine}`,
    `• ${karlancerLine}`,
  ];
  if (opts.lastScanAt) lines.push(`• آخرین اسکن: ${formatAgeFa(opts.lastScanAt)}`);
  if ((opts.pendingApprovals || 0) > 0) {
    lines.push(`• تأیید باز: ${toFaNum(opts.pendingApprovals)}`);
  }
  lines.push(
    '',
    'از دکمه‌های زیر شروع کنید، یا منوی پایین را بزنید.'
  );
  return lines.join('\n');
}

export function formatHelp() {
  return [
    '❓ راهنما',
    '————————',
    '',
    'نقشهٔ سریع — بدون اصطلاح فنی:',
    '',
    `• 🏠 خانه — شروع و میان‌بر`,
    `• ${BTN.DASHBOARD} — سیستم سالم است؟`,
    `• ${BTN.CHATS} — گفتگوهای کارلنسر`,
    `• ${BTN.OPPORTUNITIES} — پروژه‌های پیشنهادی`,
    `• ${BTN.INBOX} — کارهای منتظر تصمیم شما`,
    `• ${BTN.APPROVALS} — تأیید یا رد ارسال`,
    `• ${BTN.CONTROL} — کنترل کامل (خواندن / مغز / امنیت / اعلان)`,
    `• ${BTN.SETTINGS} — حالت اجرا و توقف اضطراری`,
    `• ${BTN.ALERTS} — مهم‌ها (از کنترل → خواندن داده)`,
    '',
    'در هر گفتگو: مشاهده · تحلیل · پیش‌نویس · ارسال',
    'قبل از ارسال حساس، پیش‌نمایش و تأیید می‌آید.',
    '',
    'دستورات میان‌بر: /start · /control · /status · /opportunities · /inbox · /help',
    '',
    '🔐 نشست: توکن مرورگر بهتر است؛ رمز را در چت نگه ندارید.',
    '⚠️ تلگرام E2E واقعی نیست — سرور می‌تواند پیام را ببیند.',
  ].join('\n');
}

export function formatScanQueued(jobId) {
  return formatScanQueuedUx(jobId);
}

export function formatDecideResult({ approve, approvalId, jobStatus, note }) {
  const verb = approve ? 'تأیید شد' : 'رد شد';
  const short = String(approvalId || '').slice(0, 8);
  const lines = [
    approve ? '✅ انجام شد' : '❌ رد شد',
    verb,
    `شناسه: ${short}…`,
  ];
  if (jobStatus) lines.push(`وضعیت وظیفه: ${jobStatus}`);
  if (note) lines.push(String(note));
  return lines.join('\n');
}

/** Loading / complete UX helpers */
export function formatLoading(kind = 'default') {
  const map = {
    default: '⏳ لطفاً صبر کنید…',
    status: '⏳ در حال بارگذاری داشبورد…',
    chats: '⏳ در حال دریافت گفتگوها…',
    unread: '⏳ در حال دریافت مهم‌ها…',
    room: '⏳ در حال باز کردن گفتگو…',
    ai: '🤖 در حال تحلیل AI…',
    note: '⏳ در حال اعمال نوت…',
    scan: '⏳ در حال صف‌کردن اسکن…',
    send: '⏳ در حال ثبت ارسال…',
    refresh: '🔄 در حال تازه‌سازی…',
  };
  return map[kind] || map.default;
}

export function formatComplete(kind = 'default', detail = '') {
  const map = {
    default: '✅ آماده',
    ai: '✅ تحلیل کامل شد',
    note: '✅ نوت اعمال شد',
    scan: '✅ اسکن در صف قرار گرفت',
    send: '✅ تأیید ثبت شد',
    reject: '✅ رد ثبت شد',
    refresh: '✅ به‌روز شد',
  };
  const base = map[kind] || map.default;
  return detail ? `${base}\n${detail}` : base;
}

/**
 * Map technical / Axios errors to short Persian UX copy.
 * Never leak tokens or raw stack.
 * @param {unknown} err
 * @param {{ retryHint?: boolean }} [opts]
 */
export function friendlyErrorText(err, { retryHint = false } = {}) {
  const raw = redactString(String(err?.message || err || '')).slice(0, 240);
  const lower = raw.toLowerCase();
  let fa = 'مشکلی پیش آمد. لطفاً دوباره تلاش کنید.';
  if (
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('econnaborted')
  ) {
    fa = 'اتصال طولانی شد. کمی بعد دوباره تلاش کنید.';
  } else if (
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed')
  ) {
    fa = 'ارتباط با سرور برقرار نشد. اتصال را بررسی کنید.';
  } else if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('احراز')
  ) {
    fa = 'نشست کارلنسر منقضی یا نامعتبر است. از تنظیمات «🔐 تمدید نشست» را بزنید.';
  } else if (lower.includes('404') || lower.includes('not found')) {
    fa = 'مورد درخواستی پیدا نشد.';
  } else if (lower.includes('429') || lower.includes('rate')) {
    fa = 'درخواست زیاد بود. کمی صبر کنید و دوباره بزنید.';
  } else if (lower.includes('500') || lower.includes('502') || lower.includes('503')) {
    fa = 'سرور موقتاً در دسترس نیست. بعداً تلاش کنید.';
  } else if (lower.includes('axios') || lower.includes('request failed')) {
    fa = 'درخواست به API ناموفق بود. دوباره تلاش کنید.';
  } else if (raw && !lower.includes('bearer') && raw.length < 120) {
    // Keep short non-secret detail when useful
    fa = `خطا: ${raw}`;
  }
  if (retryHint) fa += '\nدکمه «تلاش دوباره» را بزنید.';
  return fa;
}

export function formatFriendlyError(err, { title = '⚠️ خطا', retryCallback = null } = {}) {
  return {
    text: [title, '————————', '', friendlyErrorText(err, { retryHint: Boolean(retryCallback) })].join(
      '\n'
    ),
    keyboard: retryCallback
      ? new InlineKeyboard()
          .text('🔁 تلاش دوباره', retryCallback)
          .row()
          .text('🏠 خانه', 'nav:home')
          .text('📊 داشبورد', 'nav:dash')
      : new InlineKeyboard().text('🏠 خانه', 'nav:home').text('📊 داشبورد', 'nav:dash'),
  };
}

/**
 * Map reply-keyboard text → logical action.
 * @param {string} text
 */
export function mapMenuText(text) {
  const t = (text || '').trim();
  if (t === BTN.DASHBOARD || t === BTN.STATUS || t === BTN.DASHBOARD_LEGACY) return 'dashboard';
  if (t === BTN.CHATS || t === BTN.CHATS_LEGACY) return 'chats';
  if (t === BTN.OPPORTUNITIES) return 'opportunities';
  if (t === BTN.INBOX) return 'inbox';
  if (t === BTN.ALERTS || t === BTN.UNREAD || t === BTN.ALERTS_LEGACY) return 'alerts';
  if (t === BTN.APPROVALS || t === BTN.APPROVALS_LEGACY) return 'approvals';
  if (t === BTN.CONTROL) return 'control';
  if (t === BTN.SETTINGS || t === BTN.SETTINGS_LEGACY) return 'settings';
  if (t === BTN.HELP || t === BTN.HELP_LEGACY) return 'help';
  if (t === BTN.SCAN) return 'scan';
  if (t === BTN.PAUSE) return 'pause';
  if (t === BTN.RESUME) return 'resume';
  if (t === 'مکث/ادامه') return 'pause';
  return null;
}

/**
 * Truncate preview for Telegram cards (no secrets).
 * @param {string} s
 * @param {number} [max=72]
 */
export function truncatePreview(s, max = 72) {
  return truncatePersianText(s, { max, lines: 2 });
}

/**
 * Persian summary card after rooms.scan (one message per job).
 */
export function formatScanSummary(s = {}) {
  return formatScanSummaryUx(s);
}
