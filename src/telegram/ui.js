import { Keyboard, InlineKeyboard } from 'grammy';
import { redactString } from '../security/redaction.js';
import { parseRoomCallback } from './room-card.js';

/** Reply-keyboard button labels (exact match for hears / text map). Max 6 main items. */
export const BTN = Object.freeze({
  DASHBOARD: 'داشبورد',
  CHATS: 'گفتگوها',
  ALERTS: 'هشدارها',
  APPROVALS: 'تأییدها',
  SETTINGS: 'تنظیمات',
  HELP: 'راهنما',
  // Legacy aliases (still mapped for mid-session keyboards)
  STATUS: 'وضعیت',
  UNREAD: 'خوانده‌نشده',
  SCAN: 'اسکن',
  PAUSE: 'مکث',
  RESUME: 'ادامه',
  CHATS_LEGACY: 'چت‌ها',
});

/** BotCommand list for setMyCommands (Persian) — matches new IA. */
export const BOT_COMMANDS = [
  { command: 'start', description: 'داشبورد عملیات AI' },
  { command: 'status', description: 'داشبورد سلامت سیستم' },
  { command: 'chats', description: 'گفتگوهای کارلنسر' },
  { command: 'unread', description: 'هشدارها و خوانده‌نشده' },
  { command: 'approvals', description: 'تأییدهای در انتظار' },
  { command: 'scan', description: 'صف‌کردن اسکن دعوت‌ها' },
  { command: 'pause', description: 'مکث موقت ایجنت' },
  { command: 'resume', description: 'ادامه کار ایجنت' },
  { command: 'help', description: 'راهنمای داشبورد' },
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
    .text('🏠 خانه', 'nav:home')
    .text('🔄 تازه‌سازی', 'goto:approvals');
}

/**
 * Shared nav row: Back / Home / Refresh where applicable.
 * @param {{ back?: string, refresh?: string, home?: boolean }} [opts]
 */
export function navRow(kb, { back = 'nav:home', refresh = null, home = true } = {}) {
  if (back) kb.text('◀️ بازگشت', back);
  if (home) kb.text('🏠 خانه', 'nav:home');
  if (refresh) kb.text('🔄', refresh);
  return kb;
}

/**
 * @param {{ pendingCount?: number, healthy?: boolean|null }} [opts]
 */
export function statusInlineKeyboard({ pendingCount = 0 } = {}) {
  const kb = new InlineKeyboard()
    .text('🔄 تازه‌سازی', 'refresh:status')
    .text('🏠 خانه', 'nav:home');
  if (pendingCount > 0) {
    kb.row().text(`📋 تأییدها (${pendingCount})`, 'goto:approvals');
  }
  kb.row()
    .text('💬 گفتگوها', 'goto:chats')
    .text('🔔 هشدارها', 'goto:unread');
  return kb;
}

export function afterScanInlineKeyboard() {
  return new InlineKeyboard()
    .text('📋 تأییدها', 'goto:approvals')
    .text('💬 گفتگوها', 'goto:chats')
    .row()
    .text('🔔 هشدارها', 'goto:unread')
    .text('📊 داشبورد', 'refresh:status')
    .row()
    .text('🏠 خانه', 'nav:home');
}

/**
 * @param {'running'|'paused'} agentState
 */
export function settingsInlineKeyboard(agentState = 'running') {
  const kb = new InlineKeyboard();
  if (agentState === 'paused') {
    kb.text('▶️ ادامه', 'set:resume');
  } else {
    kb.text('⏸ مکث', 'set:pause');
  }
  kb.text('📡 اسکن الان', 'set:scan')
    .row()
    .text('◀️ بازگشت', 'nav:dash')
    .text('🏠 خانه', 'nav:home')
    .text('🔄', 'nav:set');
  return kb;
}

export function homeInlineKeyboard() {
  return new InlineKeyboard()
    .text('📊 داشبورد', 'nav:dash')
    .text('💬 گفتگوها', 'goto:chats')
    .row()
    .text('🔔 هشدارها', 'goto:unread')
    .text('📋 تأییدها', 'goto:approvals')
    .row()
    .text('⚙️ تنظیمات', 'nav:set')
    .text('📖 راهنما', 'nav:help');
}

/**
 * Parse callback_data. Returns null if unknown/invalid.
 * @param {string} data
 */
export function parseCallbackData(data) {
  if (typeof data !== 'string' || !data) return null;
  if (data === 'refresh:status') return { type: 'refresh_status' };
  if (data === 'goto:approvals') return { type: 'goto_approvals' };
  if (data === 'goto:chats') return { type: 'goto_chats' };
  if (data === 'goto:unread') return { type: 'goto_unread' };
  if (data === 'nav:home') return { type: 'nav_home' };
  if (data === 'nav:dash') return { type: 'nav_dash' };
  if (data === 'nav:set') return { type: 'nav_settings' };
  if (data === 'nav:help') return { type: 'nav_help' };
  if (data === 'set:pause') return { type: 'set_pause' };
  if (data === 'set:resume') return { type: 'set_resume' };
  if (data === 'set:scan') return { type: 'set_scan' };

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
  if (!iso) return '—';
  const t = typeof iso === 'string' ? Date.parse(iso) : +iso;
  if (!Number.isFinite(t)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  if (mins < 1) return 'همین الان';
  if (mins < 60) return `${mins} دقیقه پیش`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ساعت پیش`;
  const days = Math.floor(hours / 24);
  return `${days} روز پیش`;
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
  return {
    action: String(action),
    target: target != null ? String(target) : '—',
  };
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
 * SaaS-style System Healthy dashboard card.
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

  const lines = [
    '📊 داشبورد عملیات',
    healthHeader(health),
    '————————',
    '',
    '🖥 سیستم',
    `• ایجنت: ${stateFa}`,
    `• کارلنسر: ${karlancerLine}`,
  ];

  if (s.pollOk === true) lines.push('• poll پیام: سالم');
  else if (s.pollOk === false) lines.push('• poll پیام: خطا');
  if (s.db) lines.push(`• دیتابیس: ${s.db}`);
  if (s.worker) lines.push(`• worker: ${s.worker}`);

  lines.push(
    '',
    '📦 صف کار',
    `• در انتظار: ${s.queued ?? 0}`,
    `• در حال اجرا: ${s.running ?? 0}`,
    `• منتظر تأیید: ${s.waitingApproval ?? 0}`,
    `• تأییدهای باز: ${s.pendingApprovals ?? 0}`
  );

  lines.push('', '📡 فعالیت');
  if (s.lastScanAt) lines.push(`• آخرین اسکن: ${formatAgeFa(s.lastScanAt)}`);
  else lines.push('• آخرین اسکن: —');
  if (s.lastScanUnread != null) lines.push(`• خوانده‌نشده اسکن: ${s.lastScanUnread}`);
  if (s.lastPollAt) lines.push(`• آخرین poll: ${formatAgeFa(s.lastPollAt)}`);
  if (s.pendingRooms != null) lines.push(`• تصمیم چت باز: ${s.pendingRooms}`);
  if (s.startedAt) lines.push(`• آپ‌تایم از: ${formatAgeFa(s.startedAt)}`);
  if (s.lastCommandAt) lines.push(`• آخرین دستور: ${formatAgeFa(s.lastCommandAt)}`);

  if (s.lastError) {
    lines.push('', `⚠️ آخرین خطا: ${friendlyErrorText(s.lastError)}`);
  }
  if (s.extra) {
    const cleaned = redactString(String(s.extra)).trim().slice(0, 200);
    if (cleaned) lines.push('', cleaned);
  }
  return lines.join('\n');
}

export function formatSettingsCard(s = {}) {
  const stateFa = s.state === 'paused' ? '⏸ مکث' : '▶️ فعال';
  return [
    '⚙️ تنظیمات',
    '————————',
    '',
    `• حالت ایجنت: ${stateFa}`,
    '• اسکن: صف‌کردن بررسی دعوت‌ها',
    '',
    'از دکمه‌های زیر مکث/ادامه یا اسکن را انتخاب کنید.',
    'ارسال واقعی پیام همچنان نیازمند تأیید شماست.',
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
        '📋 تأییدها',
        '————————',
        '',
        '✅ صف تأیید خالی است.',
        '',
        'وقتی عملیاتی نیاز به تأیید شما داشته باشد، اینجا می‌آید.',
        'تا آن موقع می‌توانید گفتگوها یا هشدارها را ببینید.',
      ].join('\n'),
      keyboards: [],
    };
  }
  const slice = pending.slice(0, max);
  const blocks = [];
  const keyboards = [];
  for (let i = 0; i < slice.length; i++) {
    const a = slice[i];
    const { action, target } = approvalTarget(a);
    const shortId = String(a.approval_id || '').slice(0, 8);
    blocks.push(
      [
        `🧾 مورد ${i + 1}/${pending.length}`,
        `• عمل: ${action}`,
        `• هدف: ${target}`,
        `• سن: ${formatAgeFa(a.created_at)}`,
        `• شناسه: ${shortId}…`,
      ].join('\n')
    );
    keyboards.push(approvalActionKeyboard(a.approval_id));
  }
  let text = ['📋 تأییدهای در انتظار', '————————', '', ...blocks].join('\n\n');
  if (pending.length > max) {
    text += `\n\n… و ${pending.length - max} مورد دیگر`;
  }
  return { text, keyboards };
}

/**
 * @param {{ karlancerAuth?: boolean|null, lastScanAt?: string|null, pendingApprovals?: number }} [opts]
 */
export function formatWelcome(opts = {}) {
  const karlancerLine =
    opts.karlancerAuth === true
      ? 'کارلنسر: متصل ✅'
      : opts.karlancerAuth === false
        ? 'کارلنسر: قطع ❌'
        : 'کارلنسر: نامشخص';
  const lines = [
    'سلام 👋',
    'AI Operations Dashboard',
    '————————',
    '',
    'داشبورد عملیات کارلنسر آماده است.',
    `• ${karlancerLine}`,
  ];
  if (opts.lastScanAt) lines.push(`• آخرین اسکن: ${formatAgeFa(opts.lastScanAt)}`);
  if (opts.pendingApprovals > 0) {
    lines.push(`• تأیید باز: ${opts.pendingApprovals}`);
  }
  lines.push(
    '',
    'منوی پایین:',
    'داشبورد · گفتگوها · هشدارها',
    'تأییدها · تنظیمات · راهنما'
  );
  return lines.join('\n');
}

export function formatHelp() {
  return [
    '📖 راهنما',
    '————————',
    '',
    '🔹 منوی اصلی',
    `• ${BTN.DASHBOARD} — سلامت سیستم و صف`,
    `• ${BTN.CHATS} — لیست گفتگوها`,
    `• ${BTN.ALERTS} — خوانده‌نشده‌ها و هشدار`,
    `• ${BTN.APPROVALS} — تأیید با ✅/❌`,
    `• ${BTN.SETTINGS} — مکث، ادامه، اسکن`,
    `• ${BTN.HELP} — همین متن`,
    '',
    '🔹 داخل گفتگو',
    'مشاهده · خلاصه AI · نوت · تأیید · بازگشت',
    'قبل از ارسال، پیش‌نمایش + تأیید نهایی می‌آید.',
    '',
    '🔹 دستورات اختیاری',
    '/status · /chats · /unread · /approvals',
    '/scan · /pause · /resume · /cancel',
    '',
    'Mutationها فقط بعد از تأیید شما اجرا می‌شوند.',
    'رمز یا توکن هرگز در پیام نشان داده نمی‌شود.',
  ].join('\n');
}

export function formatScanQueued(jobId) {
  const short = String(jobId || '').slice(0, 8);
  return [
    '⏳ در صف…',
    'اسکن دعوت‌ها ثبت شد.',
    `job: ${short}…`,
    '',
    'پس از اتمام، خلاصه برایتان می‌آید.',
  ].join('\n');
}

export function formatDecideResult({ approve, approvalId, jobStatus, note }) {
  const verb = approve ? 'تأیید شد' : 'رد شد';
  const short = String(approvalId || '').slice(0, 8);
  const lines = [
    approve ? '✅ انجام شد' : '❌ رد شد',
    `${verb}`,
    `شناسه: ${short}…`,
  ];
  if (jobStatus) lines.push(`وضعیت job: ${jobStatus}`);
  if (note) lines.push(String(note));
  return lines.join('\n');
}

/** Loading / complete UX helpers */
export function formatLoading(kind = 'default') {
  const map = {
    default: '⏳ لطفاً صبر کنید…',
    status: '⏳ در حال بارگذاری داشبورد…',
    chats: '⏳ در حال دریافت گفتگوها…',
    unread: '⏳ در حال دریافت هشدارها…',
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
    fa = 'نشست کارلنسر منقضی یا نامعتبر است. توکن را در سرور تازه کنید.';
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
  if (t === BTN.DASHBOARD || t === BTN.STATUS) return 'dashboard';
  if (t === BTN.CHATS || t === BTN.CHATS_LEGACY) return 'chats';
  if (t === BTN.ALERTS || t === BTN.UNREAD) return 'alerts';
  if (t === BTN.APPROVALS) return 'approvals';
  if (t === BTN.SETTINGS) return 'settings';
  if (t === BTN.HELP) return 'help';
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
  const t = redactString(String(s || '')).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Persian summary card after rooms.scan (one message per job).
 */
export function formatScanSummary(s = {}) {
  const page = s.page ?? 1;
  const total = s.total != null ? s.total : '—';
  const lastPage = s.lastPage != null ? s.lastPage : null;
  const pageCount = s.pageCount ?? (s.priorityRooms?.length ?? 0);
  const unread = s.unreadOnPage ?? 0;
  const matched = s.matchedCount ?? 0;
  const pageLabel = lastPage != null ? `${page}/${lastPage}` : String(page);

  const lines = [
    '📡 خلاصه اسکن',
    '————————',
    '',
    `• صفحه: ${pageLabel} · در صفحه: ${pageCount}`,
    `• مجموع اتاق‌ها: ${total}`,
    `• خوانده‌نشده: ${unread}`,
    matched > 0 ? `• کاندید کلیدواژه: ${matched}` : null,
  ].filter((x) => x != null);

  const rooms = Array.isArray(s.priorityRooms) ? s.priorityRooms.slice(0, 5) : [];
  if (rooms.length) {
    lines.push('', '🔝 اولویت‌ها:');
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      const name = r.guest_name || r.guestName || r.title || '—';
      const id = r.roomId ?? r.id ?? '—';
      const ur = Number(r.unread) > 0 ? '🔴' : '⚪';
      const preview = truncatePreview(r.last_message || r.lastMessage || '', 64);
      lines.push(`${i + 1}. ${ur} ${name} · #${id}`);
      if (preview) lines.push(`   «${preview}»`);
    }
  } else {
    lines.push('', 'اولویتی در این صفحه نبود — همه آرام است.');
  }

  lines.push('', '➡️ بعدی: هشدارها یا تأییدها');
  if (s.scannedAt) lines.push(`⏱ ${formatAgeFa(s.scannedAt)}`);
  return lines.join('\n');
}
