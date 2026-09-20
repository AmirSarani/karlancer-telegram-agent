/**
 * Telegram room card formatter + inline keyboards for per-chat control.
 */
import { InlineKeyboard } from 'grammy';
import { redactString } from '../security/redaction.js';
import { formatAgeFa, truncatePreview } from './ui.js';

/**
 * Inline keyboard for a room card.
 * Callback data kept under Telegram's 64-byte limit.
 * @param {string|number} roomId
 */
export function roomCardKeyboard(roomId) {
  const id = String(roomId);
  return new InlineKeyboard()
    .text('✅ تأیید ارسال', `room:ok:${id}`)
    .text('❌ رد', `room:no:${id}`)
    .row()
    .text('📝 نوت', `room:note:${id}`)
    .text('🔄 تازه‌سازی', `room:ref:${id}`)
    .row()
    .text('🤖 تحلیل AI', `room:ai:${id}`);
}

/**
 * @param {string|number} roomId
 */
export function roomOpenKeyboard(roomId) {
  return new InlineKeyboard().text('باز کردن', `room:open:${roomId}`);
}

/**
 * Parse room-related callback_data.
 * @param {string} data
 * @returns {{ type: string, roomId?: string } | null}
 */
export function parseRoomCallback(data) {
  if (typeof data !== 'string' || !data) return null;
  const m = /^room:(open|ok|no|note|ref|ai):([0-9A-Za-z_-]{1,24})$/.exec(data);
  if (!m) return null;
  const map = {
    open: 'room_open',
    ok: 'room_approve',
    no: 'room_reject',
    note: 'room_note',
    ref: 'room_refresh',
    ai: 'room_ai',
  };
  return { type: map[m[1]], roomId: m[2] };
}

/**
 * Format a room list line for «چت‌ها» / «خوانده‌نشده».
 */
export function formatRoomListItem(room, index = 0) {
  const name = room.guestName || room.guest_name || room.title || '—';
  const id = room.roomId ?? room.id ?? '—';
  const unread = Number(room.unread) > 0 ? `🔴 ${room.unread}` : '⚪';
  const preview = truncatePreview(room.lastMessage || room.last_message || '', 48);
  const lines = [`${index + 1}. ${name} · #${id} · ${unread}`];
  if (preview) lines.push(`   «${preview}»`);
  return lines.join('\n');
}

/**
 * Build room list message + per-row open keyboards (caller sends separately).
 * @param {object[]} rooms
 * @param {{ title?: string, max?: number }} [opts]
 */
export function formatRoomsList(rooms, { title = '💬 چت‌ها', max = 10 } = {}) {
  if (!rooms?.length) {
    return { text: `${title}\n\nاتاقی برای نمایش نیست.`, items: [] };
  }
  const slice = rooms.slice(0, max);
  const lines = [title, '', `تعداد: ${rooms.length}${rooms.length > max ? ` (نمایش ${max})` : ''}`, ''];
  const items = [];
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    lines.push(formatRoomListItem(r, i));
    items.push({
      roomId: String(r.roomId ?? r.id),
      keyboard: roomOpenKeyboard(r.roomId ?? r.id),
    });
  }
  return { text: lines.join('\n'), items };
}

/**
 * Full room detail card (may be long — caller can split).
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

  const lines = [
    `🗂 کارت اتاق #${roomId}`,
    '',
    `• مهمان: ${redactString(String(guest))}`,
    unread != null ? `• خوانده‌نشده: ${unread}` : null,
    card.updatedAt ? `• به‌روزرسانی: ${formatAgeFa(card.updatedAt)}` : null,
    decisionLine(decision),
    sendStatus ? `• وضعیت ارسال: ${sendStatus}` : null,
  ].filter((x) => x != null);

  // Project block
  if (project.title || project.id || card.projectSlug) {
    lines.push('', '📁 پروژه');
    if (project.title) lines.push(`• عنوان: ${truncatePreview(project.title, 80)}`);
    if (project.id) lines.push(`• شناسه پروژه: ${project.id}`);
    if (card.projectSlug) lines.push(`• اسلاگ: ${truncatePreview(card.projectSlug, 60)}`);
    const minB = project.minBudget ?? project.min_budget;
    const maxB = project.maxBudget ?? project.max_budget;
    if (minB != null || maxB != null) {
      lines.push(`• بودجه: ${fmtNum(minB)} – ${fmtNum(maxB)}`);
    }
    const dur = project.jobDuration ?? project.job_duration ?? project.duration;
    if (dur != null) lines.push(`• مدت (اعلامی): ${dur} روز`);
    if (project.hireDeadline || project.hire_deadline) {
      lines.push(`• مهلت استخدام: ${formatAgeFa(project.hireDeadline || project.hire_deadline)}`);
    }
    const ft = project.isFulltime ?? project.is_fulltime;
    if (ft === true || ft === 1) lines.push('• تمام‌وقت: بله');
    if (project.isUrgent || project.is_urgent) lines.push('• فوری: بله');
  }

  // Proposal / price if present in messages text
  if (card.proposalPrice != null) {
    lines.push(`• پیشنهاد قیمت (استخراج‌شده): ${fmtNum(card.proposalPrice)}`);
  }
  if (card.proposalDays != null) {
    lines.push(`• پیشنهاد مدت: ${card.proposalDays} روز`);
  }

  // Last messages
  const lastN = messages.slice(-5);
  if (lastN.length) {
    lines.push('', '💬 آخرین پیام‌ها:');
    for (const m of lastN) {
      const who = m.isOwn === true ? 'من' : m.isOwn === false ? 'کارفرما' : '?';
      const t = truncatePreview(m.text || '', 120);
      lines.push(`• [${who}] ${t}`);
    }
  }

  // Files / photos
  if (files.length) {
    lines.push('', '📎 فایل‌ها / عکس‌ها:');
    for (const f of files.slice(0, 8)) {
      const label = f.name || f.kind || 'فایل';
      lines.push(`• ${label}: ${truncatePreview(f.url || '', 80)}`);
    }
  } else if (card.attachmentsNote) {
    lines.push('', `📎 ${card.attachmentsNote}`);
  }

  // Draft
  lines.push('', '📝 پیش‌نویس پاسخ (آماده تأیید):');
  if (draft) {
    lines.push(redactString(String(draft)).slice(0, 1500));
  } else {
    lines.push('(هنوز پیش‌نویسی ساخته نشده)');
  }

  if (note) {
    lines.push('', `📌 نوت مالک: ${redactString(String(note)).slice(0, 400)}`);
  }

  lines.push(
    '',
    'دکمه‌ها: ✅ تأیید ارسال · ❌ رد · 📝 نوت · 🔄 تازه‌سازی · 🤖 تحلیل AI'
  );
  if (!card.sendApiLive) {
    lines.push('⚠️ ارسال API فعلاً blocked_by_missing_api تا قرارداد VerifiedMutation ثبت شود.');
  }

  let text = lines.join('\n');
  // Telegram hard limit ~4096; keep margin
  if (text.length > 3900) {
    text = text.slice(0, 3890) + '\n…';
  }
  return text;
}

function decisionLine(status) {
  if (status === 'approved') return '• تصمیم: ✅ تأیید شده';
  if (status === 'rejected') return '• تصمیم: ❌ رد شده';
  if (status === 'blocked') return '• تصمیم: ⛔ مسدود (API)';
  return '• تصمیم: ⏳ در انتظار';
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
  roomOpenKeyboard,
  parseRoomCallback,
  formatRoomCard,
  formatRoomsList,
  formatRoomListItem,
  extractProposalHints,
};
