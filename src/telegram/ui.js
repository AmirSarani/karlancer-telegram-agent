import { Keyboard, InlineKeyboard } from 'grammy';
import { redactString } from '../security/redaction.js';
import { parseRoomCallback } from './room-card.js';

/** Reply-keyboard button labels (exact match for hears / text map). */
export const BTN = Object.freeze({
  STATUS: 'وضعیت',
  APPROVALS: 'تأییدها',
  CHATS: 'چت‌ها',
  UNREAD: 'خوانده‌نشده',
  SCAN: 'اسکن',
  PAUSE: 'مکث',
  RESUME: 'ادامه',
  HELP: 'راهنما',
});

/** BotCommand list for setMyCommands (Persian). */
export const BOT_COMMANDS = [
  { command: 'start', description: 'منوی اصلی و شروع' },
  { command: 'status', description: 'وضعیت ایجنت و صف' },
  { command: 'approvals', description: 'تأییدهای در انتظار' },
  { command: 'chats', description: 'لیست چت‌های کارلنسر' },
  { command: 'unread', description: 'چت‌های خوانده‌نشده' },
  { command: 'scan', description: 'صف‌کردن اسکن دعوت‌ها' },
  { command: 'pause', description: 'توقف موقت worker' },
  { command: 'resume', description: 'ادامه کار worker' },
  { command: 'help', description: 'راهنمای دکمه‌ها و دستورات' },
  { command: 'approve', description: 'تأیید (پیشرفته: با شناسه)' },
  { command: 'reject', description: 'رد (پیشرفته: با شناسه)' },
];

/**
 * Persistent main reply keyboard.
 * @param {'running'|'paused'} [agentState='running']
 */
export function mainMenuKeyboard(agentState = 'running') {
  const toggle = agentState === 'paused' ? BTN.RESUME : BTN.PAUSE;
  return new Keyboard()
    .text(BTN.STATUS)
    .text(BTN.APPROVALS)
    .row()
    .text(BTN.CHATS)
    .text(BTN.UNREAD)
    .row()
    .text(BTN.SCAN)
    .text(toggle)
    .row()
    .text(BTN.HELP)
    .resized()
    .persistent();
}

/** @param {string} approvalId */
export function approvalActionKeyboard(approvalId) {
  return new InlineKeyboard()
    .text('✅ تأیید', `ok:${approvalId}`)
    .text('❌ رد', `no:${approvalId}`);
}

/**
 * @param {{ pendingCount?: number }} [opts]
 */
export function statusInlineKeyboard({ pendingCount = 0 } = {}) {
  const kb = new InlineKeyboard().text('🔄 به‌روزرسانی', 'refresh:status');
  if (pendingCount > 0) {
    kb.row().text(`📋 تأییدها (${pendingCount})`, 'goto:approvals');
  }
  return kb;
}

export function afterScanInlineKeyboard() {
  return new InlineKeyboard()
    .text('📋 تأییدها', 'goto:approvals')
    .text('💬 چت‌ها', 'goto:chats')
    .row()
    .text('🔴 خوانده‌نشده', 'goto:unread')
    .text('📊 وضعیت', 'refresh:status');
}

/**
 * Parse callback_data. Returns null if unknown/invalid.
 * @param {string} data
 * @returns {{ type: string, approvalId?: string } | null}
 */
export function parseCallbackData(data) {
  if (typeof data !== 'string' || !data) return null;
  if (data === 'refresh:status') return { type: 'refresh_status' };
  if (data === 'goto:approvals') return { type: 'goto_approvals' };
  if (data === 'goto:chats') return { type: 'goto_chats' };
  if (data === 'goto:unread') return { type: 'goto_unread' };
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
 * @param {object} s
 * @param {string} [s.state]
 * @param {string} [s.startedAt]
 * @param {string|null} [s.lastCommandAt]
 * @param {number} [s.pendingApprovals]
 * @param {number} [s.queued]
 * @param {number} [s.running]
 * @param {number} [s.waitingApproval]
 * @param {boolean|null} [s.karlancerAuth]
 * @param {string|null} [s.db]
 * @param {string|null} [s.worker]
 * @param {string|null} [s.lastError]
 * @param {string|null} [s.extra]
 */
export function formatStatusCard(s = {}) {
  const stateFa = s.state === 'paused' ? '⏸ مکث' : '▶️ در حال اجرا';
  const karlancerLine =
    s.karlancerAuth === true
      ? 'کارلنسر: متصل'
      : s.karlancerAuth === false
        ? 'کارلنسر: قطع'
        : 'کارلنسر: نامشخص';
  const lines = [
    '📊 وضعیت ایجنت',
    '',
    `• حالت: ${stateFa}`,
    `• ${karlancerLine}`,
    `• صف: در انتظار ${s.queued ?? 0} · در حال اجرا ${s.running ?? 0} · منتظر تأیید ${s.waitingApproval ?? 0}`,
    `• تأییدهای باز: ${s.pendingApprovals ?? 0}`,
  ];
  if (s.lastScanAt) lines.push(`• آخرین اسکن: ${formatAgeFa(s.lastScanAt)}`);
  if (s.lastScanUnread != null) lines.push(`• خوانده‌نشده آخرین اسکن: ${s.lastScanUnread}`);
  if (s.lastPollAt) lines.push(`• آخرین poll پیام: ${formatAgeFa(s.lastPollAt)}`);
  if (s.pendingRooms != null) lines.push(`• تصمیم‌های چت باز: ${s.pendingRooms}`);
  if (s.pollOk === false) lines.push('• سلامت poll: خطا');
  else if (s.pollOk === true) lines.push('• سلامت poll: سالم');
  if (s.db) lines.push(`• دیتابیس: ${s.db}`);
  if (s.worker) lines.push(`• worker: ${s.worker}`);
  if (s.startedAt) lines.push(`• شروع: ${formatAgeFa(s.startedAt)}`);
  if (s.lastCommandAt) lines.push(`• آخرین دستور: ${formatAgeFa(s.lastCommandAt)}`);
  if (s.lastError) {
    lines.push('', `⚠️ آخرین خطا: ${redactString(String(s.lastError)).slice(0, 180)}`);
  }
  if (s.extra) {
    const cleaned = redactString(String(s.extra)).trim();
    if (cleaned) lines.push('', cleaned);
  }
  return lines.join('\n');
}

/**
 * @param {object[]} pending
 * @param {{ max?: number }} [opts]
 * @returns {{ text: string, keyboards: import('grammy').InlineKeyboard[] }}
 */
export function formatApprovalsList(pending, { max = 8 } = {}) {
  if (!pending?.length) {
    return {
      text: '✅ تأییدی در صف نیست\n\nوقتی عملیاتی نیاز به تأیید شما داشته باشد، اینجا نمایش داده می‌شود.',
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
        `🧾 تأیید ${i + 1}/${pending.length}`,
        `• عمل: ${action}`,
        `• هدف: ${target}`,
        `• سن: ${formatAgeFa(a.created_at)}`,
        `• شناسه: ${shortId}…`,
      ].join('\n')
    );
    keyboards.push(approvalActionKeyboard(a.approval_id));
  }
  let text = '📋 تأییدهای در انتظار\n\n' + blocks.join('\n\n');
  if (pending.length > max) {
    text += `\n\n… و ${pending.length - max} مورد دیگر`;
  }
  return { text, keyboards };
}

/**
 * @param {{ karlancerAuth?: boolean|null, lastScanAt?: string|null }} [opts]
 */
export function formatWelcome(opts = {}) {
  const karlancerLine =
    opts.karlancerAuth === true
      ? 'کارلنسر: متصل'
      : opts.karlancerAuth === false
        ? 'کارلنسر: قطع'
        : 'کارلنسر: نامشخص';
  const lines = [
    'سلام 👋',
    '',
    'ایجنت کارلنسر آماده است.',
    `• ${karlancerLine}`,
  ];
  if (opts.lastScanAt) lines.push(`• آخرین اسکن: ${formatAgeFa(opts.lastScanAt)}`);
  lines.push(
    '',
    'از منوی پایین استفاده کنید — نیازی به تایپ دستور نیست.',
    '',
    'دکمه‌ها: وضعیت · تأییدها · چت‌ها · خوانده‌نشده · اسکن · مکث/ادامه · راهنما'
  );
  return lines.join('\n');
}

export function formatHelp() {
  return [
    '📖 راهنما',
    '',
    '🔹 دکمه‌های منو (پیشنهادی)',
    `• ${BTN.STATUS} — کارت وضعیت و صف`,
    `• ${BTN.APPROVALS} — لیست تأیید با دکمه‌های ✅/❌`,
    `• ${BTN.CHATS} — لیست چت‌ها و کارت اتاق`,
    `• ${BTN.UNREAD} — فقط خوانده‌نشده‌ها`,
    `• ${BTN.SCAN} — صف‌کردن اسکن دعوت‌ها`,
    `• ${BTN.PAUSE} / ${BTN.RESUME} — توقف یا ادامه worker`,
    `• ${BTN.HELP} — همین متن`,
    '',
    '🔹 دستورات پیشرفته (اختیاری)',
    '/status · /approvals · /scan · /pause · /resume',
    '/approve [id] · /reject [id]',
    '',
    'Mutationها فقط بعد از تأیید شما اجرا می‌شوند.',
  ].join('\n');
}

export function formatScanQueued(jobId) {
  const short = String(jobId || '').slice(0, 8);
  return `✅ اسکن در صف قرار گرفت.\njob: ${short}…`;
}

export function formatDecideResult({ approve, approvalId, jobStatus, note }) {
  const verb = approve ? 'تأیید شد' : 'رد شد';
  const short = String(approvalId || '').slice(0, 8);
  const lines = [`${approve ? '✅' : '❌'} ${verb}`, `شناسه: ${short}…`];
  if (jobStatus) lines.push(`وضعیت job: ${jobStatus}`);
  if (note) lines.push(String(note));
  return lines.join('\n');
}

/**
 * Map reply-keyboard text → logical action.
 * @param {string} text
 * @returns {'status'|'approvals'|'scan'|'pause'|'resume'|'help'|null}
 */
export function mapMenuText(text) {
  const t = (text || '').trim();
  if (t === BTN.STATUS) return 'status';
  if (t === BTN.APPROVALS) return 'approvals';
  if (t === BTN.CHATS) return 'chats';
  if (t === BTN.UNREAD) return 'unread';
  if (t === BTN.SCAN) return 'scan';
  if (t === BTN.PAUSE) return 'pause';
  if (t === BTN.RESUME) return 'resume';
  if (t === BTN.HELP) return 'help';
  if (t === 'مکث/ادامه') return 'pause'; // legacy combined label → pause handler toggles via state in bot
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
 * @param {object} s
 * @param {number} [s.page]
 * @param {number|null} [s.total]
 * @param {number|null} [s.lastPage]
 * @param {number} [s.pageCount]
 * @param {number} [s.unreadOnPage]
 * @param {number} [s.matchedCount]
 * @param {Array<{guest_name?:string,guestName?:string,roomId?:string|number,id?:string|number,unread?:number,last_message?:string,lastMessage?:string}>} [s.priorityRooms]
 * @param {string|null} [s.scannedAt]
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
    '📡 خلاصه اسکن اتاق‌ها',
    '',
    `• صفحه: ${pageLabel} · در این صفحه: ${pageCount}`,
    `• مجموع اتاق‌ها: ${total}`,
    `• خوانده‌نشده در این صفحه: ${unread}`,
    matched > 0 ? `• دعوت‌های کاندید (کلیدواژه): ${matched}` : null,
  ].filter((x) => x != null);

  const rooms = Array.isArray(s.priorityRooms) ? s.priorityRooms.slice(0, 5) : [];
  if (rooms.length) {
    lines.push('', '🔝 اولویت‌ها:');
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      const name = r.guest_name || r.guestName || r.title || '—';
      const id = r.roomId ?? r.id ?? '—';
      const ur = Number(r.unread) > 0 ? '🔴 خوانده‌نشده' : '⚪ خوانده';
      const preview = truncatePreview(r.last_message || r.lastMessage || '', 64);
      lines.push(`${i + 1}. ${name} · #${id} · ${ur}`);
      if (preview) lines.push(`   «${preview}»`);
    }
  } else {
    lines.push('', 'اولویتی در این صفحه نبود.');
  }

  lines.push('', '➡️ بعدی: باز کردن تأییدها / پاسخ HITL');
  if (s.scannedAt) lines.push(`⏱ ${formatAgeFa(s.scannedAt)}`);
  return lines.join('\n');
}
