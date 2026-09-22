/**
 * Scan Summary mini-dashboard — Persian UX, progressive disclosure, edit-friendly.
 * Does not invent priority scores; uses backend reasons when present.
 */
import { InlineKeyboard } from 'grammy';
import { redactString } from '../security/redaction.js';

/** @typedef {'idle'|'loading'|'success'|'success_empty'|'success_with_unread'|'success_with_priority'|'partial_success'|'error'|'already_running'} ScanUiState */

export const SCAN_STATES = Object.freeze({
  idle: 'idle',
  loading: 'loading',
  success: 'success',
  success_empty: 'success_empty',
  success_with_unread: 'success_with_unread',
  success_with_priority: 'success_with_priority',
  partial_success: 'partial_success',
  error: 'error',
  already_running: 'already_running',
});

const PREVIEW_MAX = 120;
const PREVIEW_LINES = 2;
const SUMMARY_PRIORITY_MAX = 3;
const PRIORITY_PAGE_SIZE = 5;

/** UI numerals in Persian (Room IDs stay Latin). */
export function toFaNum(value) {
  if (value == null || value === '') return '—';
  return String(value).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

/**
 * Word-aware truncation, Persian-safe, ~2 lines / 100–140 chars.
 * @param {string} text
 * @param {{ max?: number, lines?: number }} [opts]
 */
export function truncatePersianText(text, { max = PREVIEW_MAX, lines = PREVIEW_LINES } = {}) {
  const raw = redactString(String(text || ''))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!raw) return '';

  const byLines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join(' ');
  let t = byLines || raw;
  if (t.length <= max) return t;

  const slice = t.slice(0, max);
  const breakAt = Math.max(
    slice.lastIndexOf(' '),
    slice.lastIndexOf('\u200c'),
    slice.lastIndexOf('،'),
    slice.lastIndexOf('.'),
    slice.lastIndexOf('؟'),
    slice.lastIndexOf('!')
  );
  const cut =
    breakAt >= Math.floor(max * 0.55)
      ? slice.slice(0, breakAt)
      : slice.replace(/\s+\S*$/, '');
  return `${(cut || slice).trimEnd()}…`;
}

/** @param {string|Date|null|undefined} iso */
export function formatRelativeTime(iso) {
  if (!iso) return '—';
  const t = typeof iso === 'string' ? Date.parse(iso) : +iso;
  if (!Number.isFinite(t)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  if (mins < 1) return 'همین الان';
  if (mins < 60) return `${toFaNum(mins)} دقیقه پیش`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${toFaNum(hours)} ساعت پیش`;
  const days = Math.floor(hours / 24);
  return `${toFaNum(days)} روز پیش`;
}

/**
 * Conservative reason — never invent severity scores.
 * @param {object} room
 */
export function priorityReasonLabel(room = {}) {
  const explicit =
    room.reason ||
    room.priorityReason ||
    room.priority_reason ||
    room.matchReason ||
    room.match_reason ||
    null;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim().slice(0, 80);
  }
  if (Number(room.unread) > 0) return 'پیام جدید';
  if (room.keywordMatched || room.matched) return 'تطابق کلیدواژه';
  if (room.related || room.isRelated) return 'مرتبط با کار شما';
  return 'در فهرست اولویت‌ها';
}

/**
 * Priority badge — never bare ⚪. Uses real signals only (no invented scores).
 * @param {object} room
 * @returns {{ emoji: string, label: string, line: string }}
 */
export function priorityBadge(room = {}) {
  const unread = Number(room.unread) > 0;
  const important =
    unread ||
    room.important === true ||
    room.isImportant === true ||
    /مهم|فوری|urgent/i.test(String(room.reason || room.priorityReason || ''));
  const review =
    room.keywordMatched ||
    room.matched ||
    room.related ||
    room.isRelated ||
    room.needsReview === true;
  if (important) {
    return { emoji: '🔥', label: 'مهم', line: '🔥 مهم' };
  }
  if (review) {
    return { emoji: '🟡', label: 'بررسی شود', line: '🟡 بررسی شود' };
  }
  return { emoji: '🔵', label: 'اطلاعاتی', line: '🔵 اطلاعاتی' };
}

/**
 * @param {object} [input]
 * @returns {ScanUiState}
 */
export function deriveScanState(input = {}) {
  if (input.state && SCAN_STATES[input.state]) return input.state;
  if (input.alreadyRunning) return SCAN_STATES.already_running;
  if (input.loading) return SCAN_STATES.loading;
  if (input.error || input.errorText) return SCAN_STATES.error;

  const rooms = Array.isArray(input.priorityRooms) ? input.priorityRooms : [];
  const unread = Number(input.unreadOnPage) || 0;
  const softFails = Number(input.softFailCount ?? input.errorsCount ?? 0) || 0;
  const partial = Boolean(input.partial) || softFails > 0;
  const hasScanMeta =
    input.scannedAt != null || input.pageCount != null || input.total != null;

  if (partial && (rooms.length > 0 || unread > 0 || (Number(input.pageCount) || 0) > 0)) {
    return SCAN_STATES.partial_success;
  }
  if (rooms.length > 0) return SCAN_STATES.success_with_priority;
  if (unread > 0) return SCAN_STATES.success_with_unread;
  if (hasScanMeta && rooms.length === 0 && unread === 0) {
    return SCAN_STATES.success_empty;
  }
  if (hasScanMeta) return SCAN_STATES.success;
  return SCAN_STATES.idle;
}

function guestName(room) {
  return redactString(
    String(room.guest_name || room.guestName || room.title || 'گفتگو')
  ).slice(0, 40);
}

function cleanPreviewText(raw) {
  let t = String(raw || '')
    .replace(/^[«»"'\s]+|[«»"'\s]+$/g, '')
    .replace(/[«»]/g, '"')
    .trim();
  return t;
}

function looksLikeFilename(t) {
  return /^[\w.\-\u0600-\u06FF]+\.(png|jpe?g|gif|webp|pdf|zip|rar|docx?|xlsx?|txt)$/i.test(t);
}

function roomPreview(room) {
  const truncated = truncatePersianText(room.last_message || room.lastMessage || '', {
    max: PREVIEW_MAX,
    lines: PREVIEW_LINES,
  });
  const cleaned = cleanPreviewText(truncated);
  if (!cleaned) return '';
  if (looksLikeFilename(cleaned.replace(/…$/, ''))) {
    return `📎 ${cleaned}`;
  }
  return cleaned;
}


function formatPreviewLine(preview) {
  if (!preview) return null;
  if (preview.startsWith('📎 ')) return `   ${preview}`;
  return `   💬 ${preview}`;
}

function roomIdOf(room) {
  return room.roomId ?? room.id ?? null;
}

/**
 * Main scan mini-dashboard card. Hides page X/Y, Room IDs, and technical keyword tally.
 * @param {object} [s]
 */
export function formatScanSummary(s = {}) {
  const state = deriveScanState(s);
  if (state === SCAN_STATES.loading) return formatScanLoading(s);
  if (state === SCAN_STATES.already_running) return formatScanAlreadyRunning(s);
  if (state === SCAN_STATES.error) return formatScanError(s).text;

  const rooms = Array.isArray(s.priorityRooms) ? s.priorityRooms : [];
  const unread = Number(s.unreadOnPage) || 0;
  const scanned = s.pageCount != null ? Number(s.pageCount) : rooms.length;
  const softFails = Number(s.softFailCount ?? s.errorsCount ?? 0) || 0;
  const needsReview = rooms.length;

  const lines = ['📡 اسکن کارلنسر'];

  if (state === SCAN_STATES.success_empty) {
    lines.push('✅ کامل شد', '');
    lines.push('✅ همه‌چیز آرام است');
    lines.push('گفتگوی نیازمند بررسی پیدا نشد.');
    if (scanned > 0) lines.push(`📂 بررسی‌شده: ${toFaNum(scanned)} گفتگو`);
    if (s.scannedAt) lines.push(`⏱ ${formatRelativeTime(s.scannedAt)}`);
    lines.push('', 'می‌توانید بعداً دوباره اسکن کنید.');
    return lines.join('\n');
  }

  if (state === SCAN_STATES.partial_success || softFails > 0) {
    lines.push('⚠️ ناقص — بخشی از گفتگوها بررسی شد');
  } else {
    lines.push('✅ کامل شد');
  }
  lines.push('');

  // Mini-dashboard metrics (honest counts; keyword match folded into reasons)
  if (needsReview > 0) {
    lines.push(`🎯 نیازمند بررسی: ${toFaNum(needsReview)}`);
  } else if (unread > 0) {
    lines.push(`🎯 نیازمند بررسی: ${toFaNum(unread)}`);
  } else {
    lines.push('🎯 نیازمند بررسی: نیست');
  }
  lines.push(`📂 در این صفحه: ${toFaNum(scanned)}`);
  if (unread > 0) {
    lines.push(`🔔 پیام جدید: ${toFaNum(unread)}`);
  } else {
    lines.push('🔔 پیام جدید: ندارید');
  }

  const showMax = SUMMARY_PRIORITY_MAX;
  const show = rooms.slice(0, showMax);
  if (show.length) {
    lines.push('', '🔥 اولویت‌ها');
    for (let i = 0; i < show.length; i++) {
      const r = show[i];
      const preview = roomPreview(r);
      const reason = priorityReasonLabel(r);
      lines.push(`${toFaNum(i + 1)}) ${guestName(r)}`);
      const previewLine = formatPreviewLine(preview);
      if (previewLine) lines.push(previewLine);
      lines.push(`   ℹ️ ${reason}`);
    }
    if (rooms.length > showMax) {
      const more = rooms.length - showMax;
      lines.push(`… و ${toFaNum(more)} مورد دیگر ← دکمه «مشاهده همه»`);
    }
  }

  if (s.scannedAt) {
    lines.push('', `⏱ ${formatRelativeTime(s.scannedAt)}`);
  }

  return lines.join('\n');
}

/** Details — page X/Y and totals only here. */
export function formatScanDetails(s = {}) {
  const page = s.page ?? 1;
  const lastPage = s.lastPage != null ? s.lastPage : null;
  const pageLabel =
    lastPage != null ? `${toFaNum(page)} از ${toFaNum(lastPage)}` : toFaNum(page);
  const lines = [
    '📊 جزئیات اسکن',
    '————————',
    '',
    `• مجموع اتاق‌ها: ${toFaNum(s.total ?? '—')}`,
    `• صفحه: ${pageLabel}`,
    `• بررسی‌شده در صفحه: ${toFaNum(s.pageCount ?? 0)}`,
    `• مرتبط / کلیدواژه: ${toFaNum(s.matchedCount ?? 0)}`,
    `• خوانده‌نشده: ${toFaNum(s.unreadOnPage ?? 0)}`,
    `• اولویت‌های فهرست‌شده: ${toFaNum(s.priorityRooms?.length ?? 0)}`,
  ];
  if (s.softFailCount || s.errorsCount) {
    lines.push(`• بررسی ناقص: ${toFaNum(s.softFailCount ?? s.errorsCount)}`);
  }
  if (s.scannedAt) lines.push(`• زمان: ${formatRelativeTime(s.scannedAt)}`);
  return lines.join('\n');
}

export function formatScanPriorityList(s = {}, { page = 1 } = {}) {
  const rooms = Array.isArray(s.priorityRooms) ? s.priorityRooms : [];
  if (!rooms.length) {
    return [
      '🔥 مهم‌ها / اولویت‌ها',
      '————————',
      '',
      'مورد اولویت‌داری در آخرین اسکن نبود.',
      'همه‌چیز آرام به‌نظر می‌رسد.',
    ].join('\n');
  }
  const totalPages = Math.max(1, Math.ceil(rooms.length / PRIORITY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * PRIORITY_PAGE_SIZE;
  const slice = rooms.slice(start, start + PRIORITY_PAGE_SIZE);
  const lines = [
    '🔥 مهم‌ها / اولویت‌ها',
    '————————',
    '',
    `تعداد: ${toFaNum(rooms.length)} · صفحه ${toFaNum(safePage)}/${toFaNum(totalPages)}`,
    '',
  ];
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    const badge = priorityBadge(r);
    const preview = roomPreview(r);
    lines.push(`${toFaNum(start + i + 1)}. ${badge.line} · ${guestName(r)}`);
    const previewLine = formatPreviewLine(preview);
    if (previewLine) lines.push(previewLine);
    lines.push(`   ℹ️ ${priorityReasonLabel(r)}`);
  }
  lines.push('', 'برای باز کردن، دکمه گفتگو را بزنید.');
  return lines.join('\n');
}

export function formatScanUnreadList(s = {}) {
  const rooms = (Array.isArray(s.priorityRooms) ? s.priorityRooms : []).filter(
    (r) => Number(r.unread) > 0
  );
  const unreadCount = Number(s.unreadOnPage) || rooms.length;
  if (!rooms.length && unreadCount === 0) {
    return [
      '🔔 خوانده‌نشده‌ها',
      '————————',
      '',
      'خوانده‌نشده‌ای در آخرین اسکن نبود — عالی است.',
    ].join('\n');
  }
  const lines = [
    '🔔 خوانده‌نشده‌ها',
    '————————',
    '',
    `تعداد در صفحه اسکن: ${toFaNum(unreadCount)}`,
    '',
  ];
  const show = rooms.slice(0, PRIORITY_PAGE_SIZE);
  for (let i = 0; i < show.length; i++) {
    const r = show[i];
    const preview = roomPreview(r);
    lines.push(`${toFaNum(i + 1)}. 🔥 مهم · ${guestName(r)} · ${toFaNum(r.unread)}`);
    const previewLine = formatPreviewLine(preview);
    if (previewLine) lines.push(previewLine);
  }
  if (!show.length && unreadCount > 0) {
    lines.push('جزئیات نام در اولویت‌ها نیست — از «مهم‌ها» ببینید.');
  }
  return lines.join('\n');
}

/**
 * Scan-context conversation card — Room ID only when showDetails.
 */
export function formatScanRoomCard(room = {}, { showDetails = false } = {}) {
  const unread = Number(room.unread) || 0;
  const preview = roomPreview(room);
  const lines = [
    '🗂 کارت گفتگو',
    '————————',
    '',
    `👤 ${guestName(room)}`,
    `🔔 خوانده‌نشده: ${toFaNum(unread)}`,
    `🏷 ${priorityReasonLabel(room)}`,
  ];
  if (preview) {
    lines.push('', '💬 آخرین پیام', preview);
  }
  if (showDetails) {
    const id = roomIdOf(room) ?? '—';
    lines.push('', '📊 جزئیات', `• Room #${id}`);
    if (room.updatedAt) lines.push(`• به‌روزرسانی: ${formatRelativeTime(room.updatedAt)}`);
  } else {
    lines.push('', 'شناسه اتاق فقط در «جزئیات» نمایش داده می‌شود.');
  }
  return lines.join('\n');
}

export function formatScanLoading(s = {}) {
  void s;
  return [
    '⏳ در حال اسکن…',
    '————————',
    '',
    'در حال بررسی گفتگوهای کارلنسر.',
    'این پیام با نتیجه نهایی جایگزین می‌شود.',
  ].join('\n');
}

export function formatScanAlreadyRunning(s = {}) {
  void s;
  return [
    '⏳ اسکن در حال اجراست',
    '————————',
    '',
    'اسکن دیگری هم‌اکنون در صف یا در حال اجراست.',
    'اسکن موازی شروع نشد — لطفاً صبر کنید.',
  ].join('\n');
}

export function formatScanError(s = {}) {
  const raw = s.errorText || s.error || s.detail || 'مشکلی در اسکن پیش آمد.';
  const text = ['⚠️ اسکن ناموفق', '————————', '', String(raw)].join('\n');
  return { text, keyboard: buildScanErrorKeyboard() };
}

/** Alias for queued/loading copy used by /scan. */
export function formatScanQueued(jobId) {
  return formatScanLoading({ jobId });
}

/** Ensure ≤2 buttons per row. */
function addPairs(kb, pairs) {
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (i > 0) kb.row();
    if (a && b) kb.text(a[0], a[1]).text(b[0], b[1]);
    else if (a) kb.text(a[0], a[1]);
  }
  return kb;
}

export function buildScanKeyboard(s = {}) {
  const state = deriveScanState(s);
  const kb = new InlineKeyboard();
  if (state === SCAN_STATES.error) return buildScanErrorKeyboard();
  if (state === SCAN_STATES.already_running || state === SCAN_STATES.loading) {
    return addPairs(kb, [
      ['🏠 خانه', 'nav:home'],
      ['📊 داشبورد', 'nav:dash'],
    ]);
  }

  const rooms = Array.isArray(s.priorityRooms) ? s.priorityRooms : [];
  const unread = Number(s.unreadOnPage) || 0;
  const pairs = [];
  if (rooms.length > 0) pairs.push([`🔥 مشاهده همه (${toFaNum(rooms.length)})`, 'scan:priority']);
  if (unread > 0) pairs.push([`🔔 خوانده‌نشده (${toFaNum(unread)})`, 'scan:unread']);
  pairs.push(['💬 گفتگوها', 'scan:chats']);
  pairs.push(['📊 جزئیات', 'scan:details']);
  pairs.push(['🔄 تازه‌سازی', 'scan:refresh']);
  pairs.push(['🏠 خانه', 'nav:home']);
  return addPairs(kb, pairs);
}

export function buildScanErrorKeyboard() {
  return addPairs(new InlineKeyboard(), [
    ['🔁 تلاش دوباره', 'scan:refresh'],
    ['🏠 خانه', 'nav:home'],
    ['📊 داشبورد', 'nav:dash'],
  ]);
}

export function buildScanDetailsKeyboard(s = {}) {
  const page = Number(s.page) || 1;
  const lastPage = s.lastPage != null ? Number(s.lastPage) : null;
  const pairs = [];
  if (lastPage != null && lastPage > 1) {
    if (page > 1) pairs.push(['◀️ صفحه قبل', `scan:page:${page - 1}`]);
    if (page < lastPage) pairs.push(['صفحه بعد ▶️', `scan:page:${page + 1}`]);
  }
  pairs.push(['◀️ بازگشت', 'scan:back']);
  pairs.push(['🔄 تازه‌سازی', 'scan:refresh']);
  pairs.push(['🏠 خانه', 'nav:home']);
  return addPairs(new InlineKeyboard(), pairs);
}

export function buildScanPriorityKeyboard(s = {}, { page = 1 } = {}) {
  const rooms = Array.isArray(s.priorityRooms) ? s.priorityRooms : [];
  const totalPages = Math.max(1, Math.ceil(Math.max(rooms.length, 1) / PRIORITY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * PRIORITY_PAGE_SIZE;
  const slice = rooms.slice(start, start + PRIORITY_PAGE_SIZE);
  const kb = new InlineKeyboard();

  for (let i = 0; i < slice.length; i += 2) {
    const a = slice[i];
    const b = slice[i + 1];
    const idA = String(roomIdOf(a));
    const labelA = truncatePersianText(guestName(a), { max: 16, lines: 1 }) || idA;
    kb.text(`👁 ${labelA}`, `room:open:${idA}`);
    if (b) {
      const idB = String(roomIdOf(b));
      const labelB = truncatePersianText(guestName(b), { max: 16, lines: 1 }) || idB;
      kb.text(`👁 ${labelB}`, `room:open:${idB}`);
    }
    kb.row();
  }

  const pairs = [];
  if (rooms.length > PRIORITY_PAGE_SIZE) {
    if (safePage > 1) pairs.push(['◀️ قبلی', `scan:page:${safePage - 1}`]);
    if (safePage < totalPages) pairs.push(['بعدی ▶️', `scan:page:${safePage + 1}`]);
  }
  pairs.push(['◀️ بازگشت', 'scan:back']);
  pairs.push(['🏠 خانه', 'nav:home']);
  return addPairs(kb, pairs);
}

export function buildScanUnreadKeyboard(s = {}) {
  const rooms = (Array.isArray(s.priorityRooms) ? s.priorityRooms : [])
    .filter((r) => Number(r.unread) > 0)
    .slice(0, PRIORITY_PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (let i = 0; i < rooms.length; i += 2) {
    const a = rooms[i];
    const b = rooms[i + 1];
    kb.text(
      `👁 ${truncatePersianText(guestName(a), { max: 16, lines: 1 })}`,
      `room:open:${roomIdOf(a)}`
    );
    if (b) {
      kb.text(
        `👁 ${truncatePersianText(guestName(b), { max: 16, lines: 1 })}`,
        `room:open:${roomIdOf(b)}`
      );
    }
    kb.row();
  }
  return addPairs(kb, [
    ['🔥 همه مهم‌ها', 'goto:unread'],
    ['◀️ بازگشت', 'scan:back'],
    ['🏠 خانه', 'nav:home'],
  ]);
}

export function buildScanRoomKeyboard(roomId, { aiAvailable = true } = {}) {
  const id = String(roomId);
  const pairs = [['💬 باز کردن چت', `room:open:${id}`]];
  if (aiAvailable) pairs.push(['🤖 خلاصه AI', `room:ai:${id}`]);
  pairs.push(['📝 نوت', `room:note:${id}`]);
  pairs.push(['✅ بررسی شد', `room:done:${id}`]);
  pairs.push(['📊 جزئیات اتاق', `scan:roomdetails:${id}`]);
  pairs.push(['◀️ بازگشت', 'scan:back']);
  pairs.push(['🏠 خانه', 'nav:home']);
  return addPairs(new InlineKeyboard(), pairs);
}

/** Legacy name kept for callers/tests expecting after-scan keyboard. */
export function afterScanInlineKeyboard(summary = {}) {
  return buildScanKeyboard(summary);
}

export function parseScanCallback(data) {
  if (typeof data !== 'string' || !data) return null;
  if (data === 'scan:priority') return { type: 'scan_priority' };
  if (data === 'scan:unread') return { type: 'scan_unread' };
  if (data === 'scan:refresh') return { type: 'scan_refresh' };
  if (data === 'scan:chats') return { type: 'scan_chats' };
  if (data === 'scan:details') return { type: 'scan_details' };
  if (data === 'scan:back') return { type: 'scan_back' };
  const pageM = /^scan:page:(\d{1,4})$/.exec(data);
  if (pageM) return { type: 'scan_page', page: Number(pageM[1]) };
  const roomDet = /^scan:roomdetails:([0-9A-Za-z_-]{1,24})$/.exec(data);
  if (roomDet) return { type: 'scan_room_details', roomId: roomDet[1] };
  const viewM = /^room:view:([0-9A-Za-z_-]{1,24})$/.exec(data);
  if (viewM) return { type: 'room_open', roomId: viewM[1] };
  const doneM = /^room:done:([0-9A-Za-z_-]{1,24})$/.exec(data);
  if (doneM) return { type: 'room_done', roomId: doneM[1] };
  return null;
}

export function findActiveScanJob(queue) {
  if (!queue?.list) return null;
  for (const status of ['running', 'queued']) {
    const jobs = queue.list({ status, limit: 50 }) || [];
    const hit = jobs.find((j) => j.goal === 'rooms.scan');
    if (hit) return hit;
  }
  return null;
}

export function buildScanResultMessage(summary = {}) {
  const state = deriveScanState(summary);
  if (state === SCAN_STATES.error) {
    const err = formatScanError(summary);
    return { text: err.text, reply_markup: err.keyboard, state };
  }
  return {
    text: formatScanSummary(summary),
    reply_markup: buildScanKeyboard(summary),
    state,
  };
}

export const SCAN_PRIORITY_PAGE_SIZE = PRIORITY_PAGE_SIZE;

export default {
  SCAN_STATES,
  toFaNum,
  truncatePersianText,
  formatRelativeTime,
  priorityReasonLabel,
  priorityBadge,
  deriveScanState,
  formatScanSummary,
  formatScanDetails,
  formatScanPriorityList,
  formatScanUnreadList,
  formatScanRoomCard,
  formatScanLoading,
  formatScanAlreadyRunning,
  formatScanError,
  formatScanQueued,
  buildScanKeyboard,
  afterScanInlineKeyboard,
  buildScanErrorKeyboard,
  buildScanDetailsKeyboard,
  buildScanPriorityKeyboard,
  buildScanUnreadKeyboard,
  buildScanRoomKeyboard,
  parseScanCallback,
  findActiveScanJob,
  buildScanResultMessage,
};
