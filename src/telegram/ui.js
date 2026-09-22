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
  CHATS: '💬 گفتگوها',
  ALERTS: '🔥 مهم‌ها',
  APPROVALS: '✅ تأییدها',
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
    .text(BTN.ALERTS)
    .text(BTN.APPROVALS)
    .row()
    .text(BTN.SETTINGS)
    .text(BTN.HELP)
    .resized()
    .persistent();
}

/** @param {string} approvalId */
export function approvalActionKeyboard(approvalId) {
  return new InlineKeyboard()
    .text('✅ تأیید', `ok:${approvalId}`)
    .text('❌ رد', `no:${approvalId}`)
    .row()
    .text('⬅️ بازگشت', 'goto:approvals')
    .text('🏠 خانه', 'nav:home');
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
    .text('🔥 مهم‌ها', 'goto:unread');
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
export function settingsInlineKeyboard(agentState = 'running') {
  const kb = new InlineKeyboard();
  if (agentState === 'paused') {
    kb.text('▶️ ادامه ایجنت', 'set:resume');
  } else {
    kb.text('⏸ مکث ایجنت', 'set:pause');
  }
  kb.text('📡 اجرای اسکن', 'set:scan')
    .row()
    .text('🔐 تمدید نشست', 'set:relogin')
    .row()
    .text('⬅️ بازگشت', 'nav:dash')
    .text('🏠 خانه', 'nav:home')
    .row()
    .text('🔄 بروزرسانی', 'nav:set');
  return kb;
}

export function homeInlineKeyboard() {
  return new InlineKeyboard()
    .text('📊 داشبورد', 'nav:dash')
    .text('💬 گفتگوها', 'goto:chats')
    .row()
    .text('🔥 مهم‌ها', 'goto:unread')
    .text('✅ تأییدها', 'goto:approvals')
    .row()
    .text('⚙️ تنظیمات', 'nav:set')
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
  if (data === 'refresh:status') return { type: 'refresh_status' };
  if (data === 'goto:approvals') return { type: 'goto_approvals' };
  if (data === 'goto:chats') return { type: 'goto_chats' };
  if (data === 'goto:unread') return { type: 'goto_unread' };
  if (data === 'nav:home') return { type: 'nav_home' };
  if (data === 'nav:dash') return { type: 'nav_dash' };
  if (data === 'nav:set') return { type: 'nav_settings' };
  if (data === 'nav:help') return { type: 'nav_help' };
  if (data === 'dash:details') return { type: 'dash_details' };
  if (data === 'set:pause') return { type: 'set_pause' };
  if (data === 'set:resume') return { type: 'set_resume' };
  if (data === 'set:scan') return { type: 'set_scan' };
  if (data === 'set:relogin') return { type: 'set_relogin' };
  if (data === 'set:relogin:cancel') return { type: 'set_relogin_cancel' };

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
    '🛠 جزئیات سیستم',
    '————————',
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

export function formatSettingsCard(s = {}) {
  const stateFa = s.state === 'paused' ? '⏸ مکث' : '▶️ فعال';
  const approvalMode = s.mutationNeedsApproval === false ? 'خاموش' : 'روشن';
  const authLine =
    s.karlancerAuth === true
      ? '• نشست کارلنسر: ✅ فعال'
      : s.karlancerAuth === false
        ? '• نشست کارلنسر: ❌ منقضی / نامعتبر — «تمدید نشست» را بزنید'
        : '• نشست کارلنسر: ❔ نامشخص';
  return [
    '⚙️ تنظیمات',
    '————————',
    '',
    `• ایجنت: ${stateFa}`,
    '• اسکن: بررسی گفتگوها و موارد مهم',
    `• عملیات نیازمند تأیید: ${approvalMode}`,
    authLine,
    '',
    'از دکمه‌های زیر مکث، ادامه، اسکن یا تمدید نشست را بزنید.',
    'هر ارسال واقعی فقط بعد از تأیید شما انجام می‌شود.',
    '• ارتباط‌ها روی HTTPS',
    '⚠️ رمز عبور را در تلگرام نگه ندارید؛ پس از ورود پیام‌ها را پاک کنید.',
  ].join('\n');
}

/**
 * @param {object[]} pending
 * @param {{ max?: number }} [opts]
 */
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
    blocks.push(
      [
        `🧾 مورد ${toFaNum(i + 1)} از ${toFaNum(pending.length)}`,
        `• عملیات: ${actionLabelFa(action)}`,
        `• مقصد: ${target}`,
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
    'نقشهٔ سریع صفحه‌ها:',
    '',
    `• 🏠 خانه — وضعیت کلی و میان‌برها`,
    `• ${BTN.DASHBOARD} — سالم؟ چه چیزی مهم است؟`,
    `• ${BTN.CHATS} — لیست گفتگوها`,
    `• ${BTN.ALERTS} — موارد نیازمند توجه`,
    `• ${BTN.APPROVALS} — تأیید یا رد عملیات`,
    `• ${BTN.SETTINGS} — مکث / ادامه / اسکن / تمدید نشست`,
    '',
    'داخل هر گفتگو: مشاهده · تحلیل AI · نوت',
    'قبل از ارسال، پیش‌نمایش و تأیید نهایی می‌آید.',
    '',
    'دستورات: /start · /status · /chats · /unread',
    '/approvals · /settings · /scan · /help',
    '',
    'عملیات حساس فقط بعد از تأیید شما اجرا می‌شود.',
    '',
    'تمدید نشست کارلنسر از تنظیمات (فقط مالک).',
    'ارتباط‌ها روی HTTPS (کارلنسر و API تلگرام).',
    'رمز/توکن را در چت نگه ندارید؛ تلگرام ممکن است تاریخچه نگه دارد.',
    'توجه: پیام‌های ربات تلگرام E2E نیستند — سرور تلگرام می‌تواند محتوا را ببیند.',
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
  if (t === BTN.ALERTS || t === BTN.UNREAD || t === BTN.ALERTS_LEGACY) return 'alerts';
  if (t === BTN.APPROVALS || t === BTN.APPROVALS_LEGACY) return 'approvals';
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
