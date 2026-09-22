/**
 * Telegram room / chat cards — SaaS-style ops dashboard UX.
 */
import { InlineKeyboard } from 'grammy';
import { redactString } from '../security/redaction.js';
import {
  truncatePersianText,
  formatRelativeTime,
  toFaNum,
  priorityBadge,
} from './scan-ux.js';

/** @deprecated prefer truncatePersianText — kept for callers */
export function truncatePreview(s, max = 72) {
  return truncatePersianText(s, { max, lines: 2 });
}

function formatAgeFa(iso) {
  return formatRelativeTime(iso);
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

export const ROOMS_PAGE_SIZE = 5;

/**
 * Chat detail card actions: AI Summary / Note / Approve / Reject / Refresh / Back / Home
 * @param {string|number} roomId
 */
export function roomCardKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['🤖 تحلیل AI', `room:ai:${id}`],
    ['📝 نوت', `room:note:${id}`],
    ['✅ تأیید ارسال', `room:ok:${id}`],
    ['❌ رد', `room:no:${id}`],
    ['✅ بررسی شد', `room:done:${id}`],
    ['🔄 بروزرسانی', `room:ref:${id}`],
    ['⬅️ بازگشت', 'goto:chats'],
    ['🏠 خانه', 'nav:home'],
  ]);
}

/**
 * Confirmation before send — preview + Confirm / Cancel
 * @param {string|number} roomId
 */
export function roomConfirmKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['✅ تأیید', `room:cfm:${id}`],
    ['❌ رد', `room:ccl:${id}`],
    ['⬅️ بازگشت', `room:open:${id}`],
    ['🏠 خانه', 'nav:home'],
  ]);
}

/**
 * List-row open button (View)
 * @param {string|number} roomId
 * @param {string} [label]
 */
export function roomOpenKeyboard(roomId, label = '👁 مشاهده') {
  return new InlineKeyboard().text(label, `room:open:${roomId}`);
}

/**
 * Paginated rooms list keyboard — one View button per room + nav.
 * @param {object[]} pageRooms
 * @param {{ page?: number, totalPages?: number, unreadOnly?: boolean }} [opts]
 */
export function roomsListKeyboard(pageRooms, { page = 1, totalPages = 1, unreadOnly = false } = {}) {
  const kb = new InlineKeyboard();
  for (const r of pageRooms) {
    const id = String(r.roomId ?? r.id);
    const name =
      truncatePersianText(r.guestName || r.guest_name || r.title || 'گفتگو', {
        max: 14,
        lines: 1,
      }) || 'گفتگو';
    const badge = priorityBadge(r);
    kb.text(`👁 ${badge.emoji} ${name}`, `room:open:${id}`)
      .text('🤖 تحلیل AI', `room:ai:${id}`)
      .row()
      .text('📝 نوت', `room:note:${id}`)
      .row();
  }

  const prefix = unreadOnly ? 'unrd' : 'chats';
  const pairs = [];
  if (totalPages > 1) {
    if (page > 1) pairs.push(['⬅️ قبلی', `page:${prefix}:${page - 1}`]);
    if (page < totalPages) pairs.push(['بعدی ➡️', `page:${prefix}:${page + 1}`]);
  }
  pairs.push(['🔄 بروزرسانی', unreadOnly ? 'goto:unread' : 'goto:chats']);
  pairs.push(['🏠 خانه', 'nav:home']);
  pairs.push(['📊 داشبورد', 'nav:dash']);
  return addPairs(kb, pairs);
}

/**
 * Parse room-related callback_data (kept short for 64-byte limit).
 * @param {string} data
 */
export function parseRoomCallback(data) {
  if (typeof data !== 'string' || !data) return null;
  const m = /^room:(open|ok|no|note|ref|ai|cfm|ccl|done):([0-9A-Za-z_-]{1,24})$/.exec(data);
  if (!m) return null;
  const map = {
    open: 'room_open',
    ok: 'room_approve',
    no: 'room_reject',
    note: 'room_note',
    ref: 'room_refresh',
    ai: 'room_ai',
    cfm: 'room_confirm_send',
    ccl: 'room_cancel_confirm',
    done: 'room_done',
  };
  return { type: map[m[1]], roomId: m[2] };
}

/**
 * Format a room list line for «گفتگوها» / «هشدارها».
 */
export function formatRoomListItem(room, index = 0) {
  const name = redactString(
    String(room.guestName || room.guest_name || room.title || 'گفتگو')
  ).slice(0, 40);
  const projectTitle =
    room.projectTitle ||
    room.project_title ||
    room.project?.title ||
    null;
  const badge = priorityBadge(room);
  const unreadN = Number(room.unread) || 0;
  const preview = truncatePersianText(room.lastMessage || room.last_message || '', {
    max: 90,
    lines: 2,
  });
  const when = room.updatedAt || room.updated_at || room.lastMessageAt || null;
  const lines = [
    `${toFaNum(index + 1)}. ${badge.line} · ${name}`,
  ];
  if (projectTitle) {
    lines.push(`   📁 ${truncatePersianText(String(projectTitle), { max: 48, lines: 1 })}`);
  }
  if (unreadN > 0) lines.push(`   🔔 پیام جدید: ${toFaNum(unreadN)}`);
  if (preview) lines.push(`   «${preview}»`);
  if (when) lines.push(`   ⏱ ${formatAgeFa(when)}`);
  return lines.join('\n');
}

/**
 * Build room list message + paginated inline keyboard (single message preferred).
 * @param {object[]} rooms
 * @param {{ title?: string, page?: number, pageSize?: number, unreadOnly?: boolean }} [opts]
 */
export function formatRoomsList(
  rooms,
  { title = '💬 گفتگوها', page = 1, pageSize = ROOMS_PAGE_SIZE, unreadOnly = false } = {}
) {
  if (!rooms?.length) {
    const emptyHint = unreadOnly
      ? 'فعلاً مورد مهمی نیست — عالی است! 🎉'
      : 'گفتگویی برای نمایش نیست. اسکن یا اتصال کارلنسر را بررسی کنید.';
    return {
      text: [title, '————————', '', emptyHint].join('\n'),
      items: [],
      page: 1,
      totalPages: 1,
      pageRooms: [],
      keyboard: roomsListKeyboard([], { page: 1, totalPages: 1, unreadOnly }),
    };
  }

  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const pageRooms = rooms.slice(start, start + pageSize);

  const lines = [
    title,
    '————————',
    '',
    `تعداد: ${toFaNum(rooms.length)} · صفحه ${toFaNum(safePage)}/${toFaNum(totalPages)}`,
    '',
  ];
  const items = [];
  for (let i = 0; i < pageRooms.length; i++) {
    const r = pageRooms[i];
    lines.push(formatRoomListItem(r, start + i));
    lines.push('');
    items.push({
      roomId: String(r.roomId ?? r.id),
      keyboard: roomOpenKeyboard(r.roomId ?? r.id),
    });
  }
  lines.push('از دکمه‌ها: مشاهده · تحلیل AI · نوت');

  return {
    text: lines.join('\n'),
    items,
    page: safePage,
    totalPages,
    pageRooms,
    keyboard: roomsListKeyboard(pageRooms, { page: safePage, totalPages, unreadOnly }),
  };
}

/**
 * Full room detail card.
 * @param {object} card
 */
export function formatRoomCard(card = {}) {
  const roomId = card.roomId ?? card.id ?? '—';
  const guest = card.guestName || card.guest_name || '—';
  const unread = card.unread != null ? Number(card.unread) : null;
  const project = card.project || {};
  const decision = card.decisionStatus || 'pending';
  const draft = card.draftText || card.draft?.text || '';
  const note = card.ownerNote || card.note?.text || '';
  const messages = Array.isArray(card.messages) ? card.messages : [];
  const files = Array.isArray(card.attachments) ? card.attachments : [];
  const sendStatus = card.sendStatus || null;

  const badge = priorityBadge({ unread, reason: card.priorityReason, ...card });
  const lines = [
    `🗂 گفتگو · ${badge.line}`,
    '————————',
    '',
    '👤 طرف گفتگو',
    `• نام: ${redactString(String(guest))}`,
    unread != null ? `• خوانده‌نشده: ${toFaNum(unread)}` : null,
    card.updatedAt ? `• به‌روزرسانی: ${formatAgeFa(card.updatedAt)}` : null,
    decisionLine(decision),
    sendStatus ? `• وضعیت ارسال: ${sendStatus}` : null,
  ].filter((x) => x != null);

  if (project.title || project.id || card.projectSlug) {
    lines.push('', '📁 پروژه');
    if (project.title) lines.push(`• عنوان: ${truncatePreview(project.title, 80)}`);
    if (project.id) lines.push(`• شناسه: ${project.id}`);
    if (card.projectSlug) lines.push(`• اسلاگ: ${truncatePreview(card.projectSlug, 60)}`);
    const minB = project.minBudget ?? project.min_budget;
    const maxB = project.maxBudget ?? project.max_budget;
    if (minB != null || maxB != null) {
      lines.push(`• بودجه: ${fmtNum(minB)} – ${fmtNum(maxB)}`);
    }
    const dur = project.jobDuration ?? project.job_duration ?? project.duration;
    if (dur != null) lines.push(`• مدت: ${dur} روز`);
    if (project.hireDeadline || project.hire_deadline) {
      lines.push(`• مهلت استخدام: ${formatAgeFa(project.hireDeadline || project.hire_deadline)}`);
    }
    const ft = project.isFulltime ?? project.is_fulltime;
    if (ft === true || ft === 1) lines.push('• تمام‌وقت: بله');
    if (project.isUrgent || project.is_urgent) lines.push('• فوری: بله');
  }

  if (card.proposalPrice != null) {
    lines.push(`• پیشنهاد قیمت: ${fmtNum(card.proposalPrice)}`);
  }
  if (card.proposalDays != null) {
    lines.push(`• پیشنهاد مدت: ${card.proposalDays} روز`);
  }

  const lastN = messages.slice(-5);
  if (lastN.length) {
    lines.push('', '💬 آخرین پیام‌ها');
    for (const m of lastN) {
      const who = m.isOwn === true ? 'من' : m.isOwn === false ? 'کارفرما' : '?';
      const t = truncatePreview(m.text || '', 120);
      lines.push(`• [${who}] ${t}`);
    }
  }

  if (files.length) {
    lines.push('', '📎 فایل‌ها');
    for (const f of files.slice(0, 8)) {
      const label = f.name || f.kind || 'فایل';
      lines.push(`• ${label}: ${truncatePreview(f.url || '', 80)}`);
    }
  } else if (card.attachmentsNote) {
    lines.push('', `📎 ${card.attachmentsNote}`);
  }

  lines.push('', '📊 جزئیات');
  lines.push(`• شناسه گفتگو: ${roomId}`);

  lines.push('', '📝 پیش‌نویس پاسخ');
  if (draft) {
    lines.push(redactString(String(draft)).slice(0, 1500));
  } else {
    lines.push('(هنوز پیش‌نویسی نیست — نوت یا تحلیل AI بزنید)');
  }

  if (note) {
    lines.push('', `📌 نوت شما: ${redactString(String(note)).slice(0, 400)}`);
  }

  if (!card.sendApiLive) {
    lines.push(
      '',
      'ℹ️ ارسال واقعی فعلاً فعال نیست (blocked_by_missing_api).',
      'تأیید شما ثبت می‌شود؛ ارسال پس از آماده‌شدن مسیر ارسال.'
    );
  }

  let text = lines.join('\n');
  if (text.length > 3900) {
    text = text.slice(0, 3890) + '\n…';
  }
  return text;
}

/**
 * Confirmation preview before send.
 */
export function formatSendConfirmPreview(card = {}) {
  const roomId = card.roomId ?? card.id ?? '—';
  const guest = card.guestName || card.guest_name || '—';
  const draft = redactString(String(card.draftText || card.draft?.text || '')).slice(0, 1200);
  const lines = [
    '⚠️ تأیید قبل از ارسال',
    '————————',
    '',
    '• عملیات: ارسال پیام',
    `• مقصد: ${redactString(String(guest))}`,
    `• گفتگو (جزئیات): ${roomId}`,
    '',
    '📤 پیش‌نمایش متن:',
    draft || '(خالی)',
    '',
  ];
  if (!card.sendApiLive) {
    lines.push(
      'ℹ️ حتی با تأیید، ارسال واقعی فعلاً',
      'blocked_by_missing_api است — صادقانه ثبت می‌شود.',
      ''
    );
  } else {
    lines.push('با تأیید، پیام در صف ارسال قرار می‌گیرد.', '');
  }
  lines.push('✅ تأیید · ❌ رد · یا بازگشت');
  return lines.join('\n');
}

/**
 * Readable AI analysis card: risk, intent, suggested action, reason.
 * @param {object} analysis
 * @param {{ roomId?: string|number, draftUpdated?: boolean }} [meta]
 */
export function formatAiAnalysisCard(analysis = {}, meta = {}) {
  const data = analysis.data || {};
  const summary = redactString(String(analysis.summary || data.summary || '')).slice(0, 800);
  const risk =
    data.risk ||
    data.riskLevel ||
    data.risk_level ||
    inferRisk(summary, analysis.ok);
  const intent = data.intent || data.goal || data.category || inferIntent(summary);
  const action =
    data.suggestedAction ||
    data.suggested_action ||
    data.action ||
    (analysis.ok ? 'بررسی پیش‌نویس و تأیید دستی' : 'بعداً دوباره تحلیل کنید');
  const reason =
    data.reason ||
    data.rationale ||
    (summary ? truncatePreview(summary, 280) : analysis.ok ? '—' : 'مدل در دسترس نبود یا خطا رخ داد');

  const lines = [
    '🤖 خلاصه تحلیل AI',
    '————————',
    '',
    meta.roomId != null ? `• گفتگو (جزئیات): ${meta.roomId}` : null,
    `• ریسک: ${riskEmoji(risk)} ${risk}`,
    `• نیت: ${intent}`,
    `• اقدام پیشنهادی: ${action}`,
    `• دلیل: ${reason}`,
  ].filter((x) => x != null);

  if (summary && summary !== reason) {
    lines.push('', '📄 جزئیات', summary.slice(0, 600));
  }
  if (meta.draftUpdated) {
    lines.push('', '✅ پیش‌نویس بر اساس تحلیل به‌روز شد.');
  } else if (analysis.ok === false) {
    lines.push('', 'ℹ️ پیش‌نویس بدون تغییر مدل به‌روز نشد.');
  }
  return lines.join('\n');
}

function inferRisk(summary, ok) {
  if (ok === false) return 'نامشخص';
  const s = String(summary || '').toLowerCase();
  if (/risk|ریسک|خطر|فوری|urgent|scam|کلاه/.test(s)) return 'بالا';
  if (/متوسط|medium|احتیاط/.test(s)) return 'متوسط';
  return 'پایین / عادی';
}

function inferIntent(summary) {
  const s = String(summary || '');
  if (/پیشنهاد|bid|قیمت/.test(s)) return 'درخواست پیشنهاد / قیمت';
  if (/سوال|سؤال|clarify/.test(s)) return 'سوال کارفرما';
  if (/استخدام|hire|تمام.?وقت/.test(s)) return 'پیگیری استخدام';
  if (!s.trim()) return 'نامشخص';
  return 'گفتگوی پروژه';
}

function riskEmoji(risk) {
  const r = String(risk || '');
  if (/بالا|high|critical/i.test(r)) return '🔴';
  if (/متوسط|medium|نامشخص/i.test(r)) return '🟡';
  return '🟢';
}

function decisionLine(status) {
  if (status === 'approved') return '• وضعیت: ✅ تأیید شده';
  if (status === 'rejected') return '• وضعیت: ❌ رد شده';
  if (status === 'blocked') return '• وضعیت: ⛔ ارسال فعلاً فعال نیست';
  if (status === 'reviewed') return '• وضعیت: ✅ بررسی شد';
  return '• وضعیت: ⏳ در انتظار';
}

function fmtNum(n) {
  if (n == null) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  try {
    return num.toLocaleString('fa-IR');
  } catch {
    return String(n);
  }
}

/**
 * Extract price/days from Persian proposal text if present.
 * @param {string} text
 */
export function extractProposalHints(text) {
  const s = String(text || '');
  let price = null;
  let days = null;
  const dayM = s.match(/مدت\s*(?:انجام)?\s*[:：]?\s*(\d+)\s*روز/i);
  if (dayM) days = Number(dayM[1]);
  const priceM =
    s.match(/هزینه\s*(?:پیشنهاد)?\s*[:：]?\s*([\d٬,.\u06F0-\u06F9]+)\s*تومان/i) ||
    s.match(/([\d٬,.\u06F0-\u06F9]{4,})\s*تومان/);
  if (priceM) {
    const cleaned = priceM[1]
      .replace(/[٬,]/g, '')
      .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
    const n = Number(cleaned);
    if (Number.isFinite(n)) price = n;
  }
  return { price, days };
}

export default {
  roomCardKeyboard,
  roomConfirmKeyboard,
  roomOpenKeyboard,
  roomsListKeyboard,
  parseRoomCallback,
  formatRoomCard,
  formatRoomsList,
  formatRoomListItem,
  formatSendConfirmPreview,
  formatAiAnalysisCard,
  extractProposalHints,
  ROOMS_PAGE_SIZE,
};
