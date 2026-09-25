/**
 * Telegram room / chat cards — User View (default) vs Technical Details.
 */
import { stripHtml } from '../agent/message-normalize.js';
import { InlineKeyboard } from 'grammy';
import { redactString } from '../security/redaction.js';
import { cleanHumanReply, detectMessageSender } from '../agent/reply-clean.js';
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
 * User View detail actions (max 2 per row).
 * @param {string|number} roomId
 */
export function roomCardKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['👁 مشاهده', `room:msg:${id}`],
    ['🤖 تحلیل', `room:ai:${id}`],
    ['📝 پیش‌نویس', `room:dft:${id}`],
    ['📤 ارسال', `room:snd:${id}`],
    ['📜 قانون خودکار', `room:rule:${id}`],
    ['🔄 بروزرسانی', `room:ref:${id}`],
    ['⚙️ جزئیات فنی', `room:tch:${id}`],
    ['✅ بررسی شد', `room:done:${id}`],
    ['⬅️ بازگشت', 'goto:chats'],
    ['🏠 خانه', 'nav:home'],
  ]);
}

/**
 * Pick-to-answer card — «جواب بدم؟»
 * @param {string|number} roomId
 */
export function roomPickKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['✅ جواب بدم', `room:pick:${id}`],
    ['⏭ بعداً', `room:skip:${id}`],
    ['👁 مشاهده', `room:msg:${id}`],
    ['🤖 تحلیل', `room:ai:${id}`],
    ['⬅️ گفتگوها', 'goto:chats'],
    ['🏠 خانه', 'nav:home'],
  ]);
}

/**
 * Answered-list open keyboard
 */
export function roomAnsweredOpenKeyboard(roomId) {
  return new InlineKeyboard()
    .text('👁 مشاهده', `room:open:${roomId}`)
    .text('💬 ادامه', `room:dft:${roomId}`);
}


/**
 * Draft reply screen keyboard.
 * ✅ تأیید → existing approval path (room:ok → confirm preview).
 * @param {string|number} roomId
 */
export function roomDraftKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['✏️ ویرایش', `room:note:${id}`],
    ['🔄 تولید دوباره', `room:rgn:${id}`],
    ['✅ تأیید', `room:ok:${id}`],
    ['❌ لغو', `room:open:${id}`],
    ['⬅️ بازگشت', `room:open:${id}`],
    ['🏠 خانه', 'nav:home'],
  ]);
}

/**
 * Messages-only view keyboard.
 * @param {string|number} roomId
 */
export function roomMessagesKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['📝 پیش‌نویس پاسخ', `room:dft:${id}`],
    ['🤖 تحلیل AI', `room:ai:${id}`],
    ['⬅️ بازگشت', `room:open:${id}`],
    ['🏠 خانه', 'nav:home'],
  ]);
}

/**
 * Technical details keyboard.
 * @param {string|number} roomId
 */
export function roomTechKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['⬅️ بازگشت', `room:open:${id}`],
    ['🏠 خانه', 'nav:home'],
    ['🔄 بروزرسانی', `room:ref:${id}`],
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
    ['⬅️ بازگشت', `room:dft:${id}`],
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
      .text('📝 پیش‌نویس', `room:dft:${id}`)
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
  const m =
    /^room:(ai|ccl|cfm|dft|done|msg|no|note|ok|open|pick|pok|pset|ref|rgn|rule|skip|snd|tch):([0-9A-Za-z_-]{1,24})$/.exec(
      data
    );
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
    pick: 'room_pick',
    skip: 'room_skip',
    msg: 'room_messages',
    dft: 'room_draft',
    tch: 'room_tech',
    rgn: 'room_regen',
    snd: 'room_send',
    rule: 'room_auto_rule',
    pok: 'room_price_ok',
    pset: 'room_price_set',
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
  const lines = [`${toFaNum(index + 1)}. ${badge.line} · ${name}`];
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
  lines.push('از دکمه‌ها: مشاهده · تحلیل AI · پیش‌نویس');

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
 * User View — clean Persian card (default). No IDs / slugs / API dump.
 * @param {object} card
 */
function priceBasisFa(n, source) {
  const k = Number(n) || 0;
  if (source === 'owner_answer') return ' (قیمتی که خودتان دادید)';
  if (k > 0) return ` (بر اساس ${toFaDigits(k)} قیمت قبلی)`;
  return '';
}

function toFaDigits(v) {
  return String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

/**
 * «چه قیمتی بدهم؟» section for a room card.
 * @param {{ suggestedFa?: string, basedOnN?: number, firstTimeType?: boolean, reason?: string }} ask
 */
export function formatPriceAskLines(ask = {}) {
  const lines = ['', '💰 چه قیمتی بدهم؟'];
  if (ask.suggestedFa) {
    lines.push(`• پیشنهاد من: ${ask.suggestedFa}`);
  }
  const n = Number(ask.basedOnN) || 0;
  if (n > 0) lines.push(`• بر اساس ${toFaDigits(n)} قیمت قبلی در کارهای مشابه`);
  else lines.push('• کار مشابهی با قیمت ثبت‌شده ندارم؛ پیشنهاد از قواعد قیمت‌گذاری است.');
  lines.push(
    ask.reason === 'low_confidence'
      ? '• چون از برآورد مطمئن نیستم، قیمت را از شما می‌پرسم.'
      : '• کارفرما بودجه مشخص نکرده، قیمت را از شما می‌پرسم.'
  );
  lines.push('', '«✅ همین قیمت» را بزنید یا «✏️ مبلغ دیگر» و مبلغ را به تومان بفرستید. بعد از آن پاسخ با همین قیمت آماده می‌شود.');
  return lines;
}

/**
 * Keyboard for the price question card.
 * @param {string|number} roomId
 */
export function roomPriceKeyboard(roomId) {
  const id = String(roomId);
  return addPairs(new InlineKeyboard(), [
    ['✅ همین قیمت', `room:pok:${id}`],
    ['✏️ مبلغ دیگر', `room:pset:${id}`],
    ['👁 مشاهده', `room:msg:${id}`],
    ['⏭ بعداً', `room:skip:${id}`],
    ['⬅️ گفتگوها', 'goto:chats'],
    ['🏠 خانه', 'nav:home'],
  ]);
}

const TIER_FA = { small: 'کوچک', medium: 'متوسط', large: 'بزرگ' };
const COMPLEXITY_FA = { low: 'ساده', medium: 'متوسط', high: 'پیچیده' };

/**
 * Full «💰 چه قیمتی بدهم؟» card: project context + client requests + scope + why this price
 * (+ draft preview when present). Long output is split into sequential messages by the sender.
 * @param {object} card
 */
export function formatPriceAskCard(card = {}) {
  const ask = card.priceAsk || {};
  const project = card.project || {};
  const detail = card.analysisDetail || {};
  const guest = card.guestName || card.guest_name || 'کارفرما';
  const minB = project.minBudget ?? project.min_budget;
  const maxB = project.maxBudget ?? project.max_budget;
  const desc = stripHtml(String(project.description || '')).trim();
  const skills = Array.isArray(project.skills) ? project.skills.filter(Boolean).map(String) : [];
  const lines = ['💰 چه قیمتی بدهم؟', '', `👤 کارفرما: ${redactString(String(guest))}`];

  lines.push('', '📁 پروژه');
  lines.push(`• عنوان: ${project.title ? redactString(String(project.title)) : 'گفتگوی مستقیم بدون پروژه'}`);
  const budgetFa =
    minB != null && maxB != null
      ? `${fmtNum(minB)} تا ${fmtNum(maxB)} تومان`
      : minB != null || maxB != null
        ? formatBudgetFa(minB, maxB)
        : 'کارفرما بودجه مشخص نکرده';
  lines.push(`• بودجه: ${budgetFa}`);
  if (project.category) lines.push(`• دسته: ${redactString(String(project.category))}`);
  if (skills.length) lines.push(`• مهارت‌ها: ${skills.slice(0, 12).join('، ')}`);
  const dur = project.jobDuration ?? project.job_duration;
  if (dur != null && String(dur).trim() !== '') lines.push(`• مدت اعلام‌شده: ${formatDurationFa(dur)}`);
  if (desc) lines.push('', '📄 شرح کامل پروژه:', redactString(desc));

  // Client's requests from the chat
  const reqs = Array.isArray(detail.requirements) ? detail.requirements.filter(Boolean) : [];
  const clientMsgs = (Array.isArray(card.messages) ? card.messages : [])
    .filter((m) => detectMessageSender(m) !== 'you')
    .slice(-3)
    .map((m) => redactString(stripMsgMarkers(m.text || '')).trim())
    .filter(Boolean);
  lines.push('', '🗣 خواسته‌های کارفرما در گفتگو');
  if (detail.summary) lines.push(`• خلاصه: ${redactString(String(detail.summary))}`);
  for (const r of reqs.slice(0, 10)) lines.push(`• ${redactString(String(r))}`);
  if (!detail.summary && !reqs.length) {
    if (clientMsgs.length) for (const t of clientMsgs) lines.push(`• «${t}»`);
    else lines.push('• پیام مشخصی از کارفرما ثبت نشده');
  }

  // Scope estimate
  const tier = ask.tier || null;
  const est = [];
  if (tier && TIER_FA[tier]) est.push(`حجم کار: ${TIER_FA[tier]}`);
  if (detail.complexity && COMPLEXITY_FA[detail.complexity]) est.push(`سختی: ${COMPLEXITY_FA[detail.complexity]}`);
  if (detail.estimatedDays) est.push(`زمان تقریبی: ${toFaNum(detail.estimatedDays)} روز کاری`);
  if (est.length) {
    lines.push('', '📏 برآورد');
    for (const e of est) lines.push(`• ${e}`);
  }

  // Suggestion + why
  lines.push('', '💡 قیمت پیشنهادی');
  lines.push(`• ${ask.suggestedFa || 'هنوز برآوردی ندارم'}`);
  if (ask.range?.low && ask.range?.high) {
    lines.push(`• بازهٔ مناسب این کار: ${fmtNum(ask.range.low)} تا ${fmtNum(ask.range.high)} تومان`);
  }
  const why = ask.reasonFa || (Number(ask.basedOnN) > 0 ? `بر اساس ${toFaNum(ask.basedOnN)} قیمت قبلی در کارهای مشابه` : 'از قواعد قیمت‌گذاری؛ کار مشابهی با قیمت ثبت‌شده ندارم');
  lines.push(`• چرا این قیمت: ${why}`);
  lines.push(
    ask.reason === 'low_confidence'
      ? '• چون از برآورد مطمئن نیستم، قیمت را از شما می‌پرسم.'
      : '• کارفرما بودجه مشخص نکرده، قیمت را از شما می‌پرسم.'
  );

  const draft = cleanHumanReply(redactString(String(card.draftText || '')));
  if (draft) {
    lines.push('', '📝 پیش‌نویس پاسخ (بعد از تعیین قیمت نهایی می‌شود):', draft);
  }
  lines.push('', '«✅ همین قیمت» را بزنید یا «✏️ مبلغ دیگر» و مبلغ را به تومان بفرستید.');
  return lines.join('\n');
}

export function formatRoomCard(card = {}) {
  if (card.continuumAction === 'price_ask' && card.priceAsk) return formatPriceAskCard(card);
  const guest = card.guestName || card.guest_name || '—';
  const unread = card.unread != null ? Number(card.unread) : null;
  const project = card.project || {};
  const decision = card.decisionStatus || 'pending';
  const draft = cleanHumanReply(redactString(String(card.draftText || card.draft?.text || '')));
  const note = card.ownerNote || card.note?.text || '';
  const messages = Array.isArray(card.messages) ? card.messages : [];
  const badge = priorityBadge({ unread, reason: card.priorityReason, ...card });

  const title = project.title || card.projectTitle || null;
  const minB = project.minBudget ?? project.min_budget;
  const maxB = project.maxBudget ?? project.max_budget;
  const dur = project.jobDuration ?? project.job_duration ?? project.duration;
  const when =
    card.updatedAt ||
    card.updated_at ||
    card.lastMessageAt ||
    null;

  const lines = [
    `🗂 گفتگو · ${badge.line}`,
    '————————',
    '',
    '👤 کارفرما',
    redactString(String(guest)),
  ];

  if (title || minB != null || maxB != null || dur != null) {
    lines.push('', '📁 پروژه');
    if (title) {
      lines.push(`• عنوان: ${truncatePersianText(String(title), { max: 80, lines: 2 })}`);
    }
    if (minB != null || maxB != null) {
      lines.push(`• بودجه: ${formatBudgetFa(minB, maxB)}`);
    }
    if (dur != null && String(dur).trim() !== '') {
      lines.push(`• مدت: ${formatDurationFa(dur)}`);
    }
  }

  if (when) lines.push(`• آخرین فعالیت: ${formatAgeFa(when)}`);
  if (unread != null && unread > 0) {
    lines.push(`• پیام جدید: ${toFaNum(unread)}`);
  }
  lines.push(decisionLine(decision));
  if (card.threadPhase === 'answered') lines.push('• فاز: ✅ جواب‌داده‌شده');
  else if (card.threadPhase === 'active_thread') lines.push('• فاز: 🔁 ادامه گفتگو');
  if (card.chatAiModeFa) lines.push(`• حالت AI چت: ${card.chatAiModeFa}`);
  if (card.analysisSummary) {
    lines.push('', '🧠 خلاصه AI', truncatePersianText(String(card.analysisSummary), { max: 220, lines: 3 }));
  }
  if (card.suggestedPriceFa && !card.priceAsk) {
    lines.push(`• قیمت پیشنهادی (داخلی): ${card.suggestedPriceFa}${priceBasisFa(card.priceBasedOnN, card.priceSource)}`);
  }
  if (card.pickPrompt && card.gateVerdict?.reasonFa) {
    lines.push(`• چرا خودکار نفرستادم: ${truncatePersianText(String(card.gateVerdict.reasonFa), { max: 140, lines: 2 })}`);
  }
  if (card.pickPrompt) {
    lines.push('', '❓ جواب بدم؟ از دکمه‌ها یکی را انتخاب کنید.');
  }
  if (card.priceAsk) {
    lines.push(...formatPriceAskLines(card.priceAsk));
  }

  const msgBlock = formatLastMessagesBlock(messages, { max: 5 });
  if (msgBlock) {
    lines.push('', msgBlock);
  }

  if (draft) {
    lines.push(
      '',
      '📝 پیش‌نویس',
      truncatePersianText(draft, { max: 220, lines: 4 }),
      'وضعیت: آماده بررسی — برای متن کامل «پیش‌نویس پاسخ» را بزنید.'
    );
  } else {
    lines.push('', '📝 پیش‌نویس هنوز آماده نیست — از «پیش‌نویس پاسخ» بسازید.');
  }

  if (note) {
    lines.push(
      '',
      `📌 نوت شما: ${truncatePersianText(redactString(String(note)), { max: 160, lines: 2 })}`
    );
  }

  // Long cards are split into sequential messages by the sender (split-text.js).
  return lines.filter((x) => x != null).join('\n');
}

/**
 * Technical details only — IDs, slugs, API flags. Not the default view.
 * @param {object} card
 */
export function formatRoomTechDetails(card = {}) {
  const roomId = card.roomId ?? card.id ?? '—';
  const project = card.project || {};
  const files = Array.isArray(card.attachments) ? card.attachments : [];
  const sendStatus = card.sendStatus || null;
  const lines = [
    '⚙️ جزئیات فنی',
    '————————',
    '',
    `• شناسه گفتگو: ${roomId}`,
  ];
  if (project.id) lines.push(`• شناسه پروژه: ${project.id}`);
  if (card.projectSlug) {
    lines.push(`• اسلاگ: ${truncatePreview(card.projectSlug, 60)}`);
  }
  const ft = project.isFulltime ?? project.is_fulltime;
  if (ft === true || ft === 1) lines.push('• تمام‌وقت: بله');
  if (project.isUrgent || project.is_urgent) lines.push('• فوری: بله');
  if (project.hireDeadline || project.hire_deadline) {
    lines.push(
      `• مهلت استخدام: ${formatAgeFa(project.hireDeadline || project.hire_deadline)}`
    );
  }
  if (card.proposalPrice != null) {
    lines.push(`• پیشنهاد قیمت (داخلی): ${fmtNum(card.proposalPrice)}`);
  }
  if (card.proposalDays != null) {
    lines.push(`• پیشنهاد مدت (داخلی): ${card.proposalDays} روز`);
  }
  if (sendStatus) lines.push(`• وضعیت ارسال: ${sendStatus}`);
  lines.push(
    `• مسیر ارسال: ${card.sendApiLive ? 'آماده (قرارداد تأییدشده)' : 'فعلاً غیرفعال'}`
  );
  if (!card.sendApiLive) {
    lines.push('• توضیح: ارسال واقعی پس از آماده‌شدن مسیر API');
    lines.push('• کد داخلی: blocked_by_missing_api');
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

  lines.push('', 'این صفحه فقط برای عیب‌یابی است؛ نمای اصلی کارت گفتگو است.');
  return lines.join('\n');
}

/**
 * Friendly last-messages block.
 * @param {object[]} messages
 * @param {{ max?: number, title?: boolean }} [opts]
 */
export function formatLastMessagesBlock(messages = [], { max = 8, title = true } = {}) {
  const lastN = (Array.isArray(messages) ? messages : []).slice(-max);
  if (!lastN.length) return '';
  const lines = title ? ['💬 آخرین پیام‌ها'] : [];
  for (const m of lastN) {
    const who = senderLabelFa(detectMessageSender(m));
    const t = truncatePersianText(stripMsgMarkers(m.text || ''), {
      max: 140,
      lines: 2,
    });
    if (!t) continue;
    lines.push(`${who} ${t}`);
  }
  return lines.length > (title ? 1 : 0) ? lines.join('\n') : '';
}

/**
 * Standalone messages screen.
 * @param {object} card
 */
export function formatRoomMessagesView(card = {}) {
  const guest = card.guestName || card.guest_name || 'کارفرما';
  const messages = Array.isArray(card.messages) ? card.messages : [];
  const block = formatFullMessagesBlock(messages, { max: 12 });
  const project = card.project || {};
  const desc = stripHtml(String(project.description || '')).trim();
  return [
    '💬 پیام‌های گفتگو',
    '————————',
    '',
    `👤 ${redactString(String(guest))}`,
    project.title ? `📁 ${redactString(String(project.title))}` : null,
    '',
    block || 'هنوز پیامی برای نمایش نیست.',
    desc ? '' : null,
    desc ? '📄 شرح کامل پروژه:' : null,
    desc ? redactString(desc) : null,
  ]
    .filter((l) => l != null)
    .join('\n');
}

/**
 * Messages with their FULL text (for the messages screen; long output is split by the sender).
 */
export function formatFullMessagesBlock(messages = [], { max = 12 } = {}) {
  const lastN = (Array.isArray(messages) ? messages : []).slice(-max);
  const lines = ['💬 آخرین پیام‌ها'];
  for (const m of lastN) {
    const who = senderLabelFa(detectMessageSender(m));
    const t = redactString(stripMsgMarkers(m.text || '')).trim();
    if (!t) continue;
    lines.push('', `${who} ${t}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Draft reply screen UX.
 * @param {object} card
 */
export function formatDraftScreen(card = {}) {
  const draft = cleanHumanReply(redactString(String(card.draftText || card.draft?.text || '')));
  const guest = card.guestName || card.guest_name || 'کارفرما';
  const lines = [
    '📝 پیش‌نویس پاسخ',
    '————————',
    '',
    `برای: ${redactString(String(guest))}`,
    '',
  ];
  if (draft) {
    lines.push(redactString(draft).slice(0, 2800));
    lines.push('', 'وضعیت: ✅ آماده بررسی');
  } else {
    lines.push('(هنوز متنی نیست — «تولید دوباره» یا ویرایش را بزنید.)');
    lines.push('', 'وضعیت: ⏳ در انتظار پیش‌نویس');
  }
  lines.push('', 'تأیید → پیش‌نمایش و ثبت تأیید (ارسال واقعی طبق قرارداد).');
  return lines.join('\n');
}

/**
 * Confirmation preview before send.
 */
export function formatSendConfirmPreview(card = {}) {
  const roomId = card.roomId ?? card.id ?? '—';
  const guest = card.guestName || card.guest_name || '—';
  const draft = cleanHumanReply(
    redactString(String(card.draftText || card.draft?.text || ''))
  ).slice(0, 1200);
  const lines = [
    '⚠️ تأیید قبل از ارسال',
    '————————',
    '',
    '• عملیات: ارسال پیام',
    `• مقصد: ${redactString(String(guest))}`,
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
  lines.push(`(جزئیات داخلی گفتگو: ${roomId})`);
  lines.push('', '✅ تأیید · ❌ رد · یا بازگشت');
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
    (summary
      ? truncatePreview(summary, 280)
      : analysis.ok
        ? '—'
        : 'مدل در دسترس نبود یا خطا رخ داد');

  const lines = [
    '🤖 خلاصه تحلیل AI',
    '————————',
    '',
    `• ریسک: ${riskEmoji(risk)} ${risk}`,
    `• نیت: ${intent}`,
    `• اقدام پیشنهادی: ${action}`,
    `• دلیل: ${reason}`,
  ];

  if (summary && summary !== reason) {
    lines.push('', '📄 جزئیات', summary.slice(0, 600));
  }
  if (meta.draftUpdated) {
    lines.push('', '✅ پیش‌نویس بر اساس تحلیل به‌روز شد.');
  } else if (analysis.ok === false) {
    lines.push('', 'ℹ️ پیش‌نویس بدون تغییر مدل به‌روز نشد.');
  }
  lines.push('', 'از «پیش‌نویس پاسخ» متن را ببینید یا ویرایش کنید.');
  return lines.join('\n');
}

function senderLabelFa(kind) {
  if (kind === 'you') return '👤 شما:';
  if (kind === 'employer') return '👤 کارفرما:';
  return '👤 طرف گفتگو:';
}

function stripMsgMarkers(text) {
  return String(text || '')
    .replace(/\[\s*\?\s*\]/g, '')
    .replace(/\[\s*(me|own|guest|employer|unknown)\s*\]/gi, '')
    .replace(/^\s*[•\-–]\s*/, '')
    .trim();
}

function formatBudgetFa(minB, maxB) {
  if (minB != null && maxB != null) return `${fmtNum(minB)} – ${fmtNum(maxB)} تومان`;
  if (minB != null) return `از ${fmtNum(minB)} تومان`;
  if (maxB != null) return `تا ${fmtNum(maxB)} تومان`;
  return '—';
}

function formatDurationFa(dur) {
  const n = Number(dur);
  if (Number.isFinite(n)) return `${toFaNum(n)} روز`;
  return String(dur);
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
  if (status === 'answered') return '• وضعیت: ✅ جواب داده شد';
  if (status === 'sending') return '• وضعیت: 📤 در حال ارسال';
  if (status === 'approved') return '• وضعیت: ✅ تأیید شده';
  if (status === 'rejected') return '• وضعیت: ❌ رد شده';
  if (status === 'blocked') return '• وضعیت: ⛔ ارسال فعلاً فعال نیست';
  if (status === 'reviewed') return '• وضعیت: ✅ بررسی شد';
  return '• وضعیت: ⏳ در انتظار بررسی';
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
  roomPickKeyboard,
  roomAnsweredOpenKeyboard,
  roomDraftKeyboard,
  roomMessagesKeyboard,
  roomTechKeyboard,
  roomConfirmKeyboard,
  roomOpenKeyboard,
  roomsListKeyboard,
  parseRoomCallback,
  formatRoomCard,
  formatRoomTechDetails,
  formatRoomMessagesView,
  formatLastMessagesBlock,
  formatDraftScreen,
  formatRoomsList,
  formatRoomListItem,
  formatSendConfirmPreview,
  formatAiAnalysisCard,
  extractProposalHints,
  ROOMS_PAGE_SIZE,
};

/**
 * Item 4: the merged price card after the owner set/accepted a price. Same message is edited.
 */
export function formatResumedPriceCard(card = {}) {
  const amount = card.suggestedPrice ?? card.priceAsk?.suggested ?? null;
  const priceFa = card.suggestedPriceFa || (amount ? `${fmtNum(amount)} تومان` : null);
  if (card.continuumAction === 'auto_sent') {
    return [
      `✅ قیمت ${priceFa || 'تعیین‌شده'} ثبت شد و پاسخ با همین قیمت ارسال شد.`,
      card.project?.title ? `• ${String(card.project.title).slice(0, 120)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const { priceAsk, ...rest } = card;
  void priceAsk;
  return [
    `✅ قیمت ${priceFa || 'تعیین‌شده'} ثبت شد. پیش‌نویس نهایی با همین قیمت آماده است و بدون تأیید شما ارسال نمی‌شود.`,
    '',
    formatRoomCard({ ...rest, suggestedPriceFa: priceFa }),
  ].join('\n');
}
