/**
 * «📚 کتاب فرصت‌ها» — Telegram-navigable archive of scans, actions, drafts, high-score opps.
 * Presentation + callbacks only; persistence lives in opportunity/store.js.
 */
import { InlineKeyboard } from 'grammy';
import {
  formatOpportunityNotify,
  formatBudgetCompact,
  faNum,
  decisionLabelShort,
} from '../opportunity/format-notify.js';
import { opportunityCardKeyboard } from './opportunity-ux.js';

export const BOOK_PAGE_SIZE = 6;
export const BOOK_NEW_WITHIN_HOURS = 72;

const ACTION_FA = Object.freeze({
  notify: 'اطلاع',
  draft_prepared: 'پیش‌نویس',
  sent_to_approvals: 'صف تأیید',
  skipped: 'رد شده',
  ignored: 'نادیده',
  approved: 'تأیید شد',
  rejected: 'رد شد',
  analyzed: 'بررسی',
  auto_enqueued: 'خودکار',
});

/**
 * @param {string} data
 * @returns {null|{ type: string, page?: number, scanId?: string, oppId?: string, draftId?: string }}
 */
export function parseBookCallback(data) {
  if (typeof data !== 'string' || !data.startsWith('book:')) return null;
  if (data === 'book:home') return { type: 'book_home' };
  let m = /^book:new:(\d{1,4})$/.exec(data);
  if (m) return { type: 'book_new', page: Number(m[1]) };
  m = /^book:hi:(\d{1,4})$/.exec(data);
  if (m) return { type: 'book_high', page: Number(m[1]) };
  m = /^book:dr:(\d{1,4})$/.exec(data);
  if (m) return { type: 'book_drafts', page: Number(m[1]) };
  m = /^book:ac:(\d{1,4})$/.exec(data);
  if (m) return { type: 'book_actions', page: Number(m[1]) };
  m = /^book:sc:(\d{1,4})$/.exec(data);
  if (m) return { type: 'book_scans', page: Number(m[1]) };
  m = /^book:all:(\d{1,4})$/.exec(data);
  if (m) return { type: 'book_all', page: Number(m[1]) };
  m = /^book:sr:([0-9A-Za-z_-]{8,48}):(\d{1,4})$/.exec(data);
  if (m) return { type: 'book_scan_run', scanId: m[1], page: Number(m[2]) };
  m = /^book:op:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'book_opp', oppId: m[1] };
  m = /^book:dv:([0-9A-Za-z_-]{1,48})$/.exec(data);
  if (m) return { type: 'book_draft_view', draftId: m[1] };
  return null;
}

export function formatBookHome(stats = {}) {
  const threshold = stats.highScoreThreshold ?? 55;
  return [
    '📚 کتاب فرصت‌ها',
    '————————',
    '',
    'آرشیو اسکن‌ها، پیش‌نویس‌ها و اقدام‌ها — بدون پخش دوبارهٔ اعلان.',
    '',
    `📦 همه: ${faNum(stats.total ?? 0)}`,
    `🆕 جدید (${faNum(BOOK_NEW_WITHIN_HOURS)}س): ${faNum(stats.newCount ?? 0)}`,
    `⭐ امتیاز ≥ ${faNum(threshold)}: ${faNum(stats.highCount ?? 0)}`,
    `📝 پیش‌نویس: ${faNum(stats.draftCount ?? 0)}`,
    `✅ اقدامات: ${faNum(stats.actionCount ?? 0)}`,
    `🔍 اسکن‌ها: ${faNum(stats.scanCount ?? 0)}`,
    '',
    'یک بخش را انتخاب کنید.',
  ].join('\n');
}

export function bookHomeKeyboard() {
  return new InlineKeyboard()
    .text('🆕 جدیدها', 'book:new:0')
    .text('⭐ امتیاز بالا', 'book:hi:0')
    .row()
    .text('📝 پیش‌نویس‌ها', 'book:dr:0')
    .text('✅ اقدامات', 'book:ac:0')
    .row()
    .text('🔍 تاریخچه اسکن', 'book:sc:0')
    .text('📋 همه', 'book:all:0')
    .row()
    .text('🔥 فرصت‌ها', 'opp:list')
    .text('🏠 خانه', 'nav:home');
}

function emptyFa(section) {
  const map = {
    new: 'هنوز فرصت جدیدی در این بازه نیست.',
    high: 'فرصت امتیازبالایی ذخیره نشده.',
    drafts: 'پیش‌نویس آماده‌ای نیست.',
    actions: 'هنوز اقدامی ثبت نشده.',
    scans: 'هنوز اسکنی در کتاب نیست — یک‌بار «اسکن فرصت» بزنید.',
    all: 'کتاب خالی است — پس از اسکن، فرصت‌ها اینجا می‌مانند.',
    scan_run: 'در این اسکن فرصتی ذخیره نشد.',
  };
  return map[section] || 'موردی نیست.';
}

function pageMeta(total, page, pageSize = BOOK_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(Math.max(total, 1) / pageSize));
  const safe = Math.min(Math.max(0, page), pages - 1);
  return { pages, safe, offset: safe * pageSize };
}

function paginateRow(kb, { prefix, page, pages }) {
  if (pages <= 1) return kb;
  const pairs = [];
  if (page > 0) pairs.push(['◀️ قبلی', `${prefix}:${page - 1}`]);
  if (page < pages - 1) pairs.push(['بعدی ▶️', `${prefix}:${page + 1}`]);
  if (pairs.length === 2) {
    kb.text(pairs[0][0], pairs[0][1]).text(pairs[1][0], pairs[1][1]).row();
  } else if (pairs.length === 1) {
    kb.text(pairs[0][0], pairs[0][1]).row();
  }
  return kb;
}

function backBookRow(kb) {
  return kb.text('📚 کتاب', 'book:home').text('🏠 خانه', 'nav:home');
}

function oppListLabel(it) {
  const score = it.score != null ? faNum(it.score) : '—';
  const title = truncate(it.title || it.id, 26);
  return `${score}｜${title}`;
}

export function formatBookOppList({ title, items = [], total = 0, page = 0, emptyKey = 'all' }) {
  const { pages, safe } = pageMeta(total, page);
  if (!items.length) {
    return [`${title}`, '————————', '', emptyFa(emptyKey)].join('\n');
  }
  const lines = [
    title,
    '————————',
    '',
    `${faNum(total)} مورد · صفحه ${faNum(safe + 1)} از ${faNum(pages)}`,
    '',
  ];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const budget = formatBudgetCompact(it.budgetMin, it.budgetMax);
    lines.push(`${faNum(safe * BOOK_PAGE_SIZE + i + 1)}) ${truncate(it.title || it.id, 40)}`);
    lines.push(
      `   💰 ${budget} · ⭐ ${it.score != null ? faNum(it.score) : '—'} · ${decisionLabelShort(it.decision)}`
    );
  }
  lines.push('', 'برای جزئیات، دکمه را بزنید.');
  return lines.join('\n');
}

export function bookOppListKeyboard(items = [], { prefix = 'book:all', page = 0, total = 0 } = {}) {
  const { pages, safe } = pageMeta(total, page);
  const kb = new InlineKeyboard();
  for (const it of items.slice(0, BOOK_PAGE_SIZE)) {
    kb.text(oppListLabel(it), `book:op:${it.id}`).row();
  }
  paginateRow(kb, { prefix, page: safe, pages });
  backBookRow(kb);
  return kb;
}

export function formatBookActions(actions = [], { total = 0, page = 0 } = {}) {
  const { pages, safe } = pageMeta(total, page);
  if (!actions.length) {
    return ['✅ اقدامات', '————————', '', emptyFa('actions')].join('\n');
  }
  const lines = [
    '✅ اقدامات',
    '————————',
    '',
    `${faNum(total)} مورد · صفحه ${faNum(safe + 1)} از ${faNum(pages)}`,
    '',
  ];
  for (const a of actions) {
    const typeFa = ACTION_FA[a.type] || a.type;
    const when = relativeFa(a.at);
    lines.push(`• ${typeFa} · ${when}`);
    if (a.preview) lines.push(`  ${truncate(a.preview, 60)}`);
    if (a.note) lines.push(`  ${truncate(a.note, 50)}`);
  }
  return lines.join('\n');
}

export function bookActionsKeyboard(actions = [], { page = 0, total = 0 } = {}) {
  const { pages, safe } = pageMeta(total, page);
  const kb = new InlineKeyboard();
  const withOpp = actions.filter((a) => a.oppId).slice(0, BOOK_PAGE_SIZE);
  for (let i = 0; i < withOpp.length; i += 2) {
    const a = withOpp[i];
    const b = withOpp[i + 1];
    kb.text(`👁 ${truncate(a.preview || a.oppId, 14)}`, `book:op:${a.oppId}`);
    if (b?.oppId) kb.text(`👁 ${truncate(b.preview || b.oppId, 14)}`, `book:op:${b.oppId}`);
    kb.row();
  }
  paginateRow(kb, { prefix: 'book:ac', page: safe, pages });
  backBookRow(kb);
  return kb;
}

export function formatBookDrafts(drafts = [], oppsById = {}, { total = 0, page = 0 } = {}) {
  const { pages, safe } = pageMeta(total, page);
  if (!drafts.length) {
    return ['📝 پیش‌نویس‌ها', '————————', '', emptyFa('drafts')].join('\n');
  }
  const lines = [
    '📝 پیش‌نویس‌ها',
    '————————',
    '',
    `${faNum(total)} مورد · صفحه ${faNum(safe + 1)} از ${faNum(pages)}`,
    '',
  ];
  for (const d of drafts) {
    const opp = oppsById[d.oppId];
    const title = opp?.title || `پروژه ${d.oppId}`;
    const price =
      d.suggestedPrice != null ? `${faNum(d.suggestedPrice)} تومان` : '—';
    lines.push(`• ${truncate(title, 40)}`);
    lines.push(`  💰 پیشنهادی: ${price}`);
    lines.push(`  ${truncate(d.body, 80)}`);
  }
  return lines.join('\n');
}

export function bookDraftsKeyboard(drafts = [], { page = 0, total = 0 } = {}) {
  const { pages, safe } = pageMeta(total, page);
  const kb = new InlineKeyboard();
  for (const d of drafts.slice(0, BOOK_PAGE_SIZE)) {
    kb.text(`📝 ${truncate(d.oppId, 20)}`, `book:dv:${d.id}`).row();
  }
  paginateRow(kb, { prefix: 'book:dr', page: safe, pages });
  backBookRow(kb);
  return kb;
}

export function formatBookDraftDetail(draft, opp = null) {
  if (!draft) return 'پیش‌نویس پیدا نشد.';
  const title = opp?.title || `پروژه ${draft.oppId}`;
  const price =
    draft.suggestedPrice != null ? `${faNum(draft.suggestedPrice)} تومان` : '—';
  const days = draft.suggestedDays != null ? faNum(draft.suggestedDays) : '—';
  return [
    '📝 پیش‌نویس ذخیره‌شده',
    '————————',
    '',
    title,
    `🆔 ${draft.oppId}`,
    `💰 قیمت پیشنهادی: ${price}`,
    `📆 روز: ${days}`,
    `وضعیت: ${draftStatusFa(draft.status)}`,
    '',
    draft.body || '—',
  ].join('\n');
}

export function bookDraftDetailKeyboard(draft) {
  const kb = new InlineKeyboard();
  if (draft?.oppId) {
    kb.text('🔥 فرصت', `book:op:${draft.oppId}`)
      .text('✅ بفرست تأییدها', `opp:bidreq:${draft.oppId}`)
      .row();
  }
  kb.text('📝 پیش‌نویس‌ها', 'book:dr:0').text('📚 کتاب', 'book:home').row();
  kb.text('🏠 خانه', 'nav:home');
  return kb;
}

export function formatBookScans(runs = [], { total = 0, page = 0 } = {}) {
  const { pages, safe } = pageMeta(total, page);
  if (!runs.length) {
    return ['🔍 تاریخچه اسکن', '————————', '', emptyFa('scans')].join('\n');
  }
  const lines = [
    '🔍 تاریخچه اسکن',
    '————————',
    '',
    `${faNum(total)} اسکن · صفحه ${faNum(safe + 1)} از ${faNum(pages)}`,
    '',
  ];
  for (const r of runs) {
    const when = relativeFa(r.at);
    if (r.skipped) {
      lines.push(`• ${when} — رد شد (${r.summary?.reason || '—'})`);
    } else {
      lines.push(
        `• ${when} — بررسی ${faNum(r.examined)} · جدید ${faNum(r.newCount)} · منطبق ${faNum(r.matched)}`
      );
      const bits = [
        r.drafted ? `پیش‌نویس ${faNum(r.drafted)}` : null,
        r.notified ? `اطلاع ${faNum(r.notified)}` : null,
        r.approvals ? `تأیید ${faNum(r.approvals)}` : null,
      ].filter(Boolean);
      if (bits.length) lines.push(`  ${bits.join(' · ')}`);
      else lines.push('  اقدامی ثبت نشد');
    }
  }
  lines.push('', 'یک اسکن را باز کنید تا فرصت‌های همان نوبت را ببینید.');
  return lines.join('\n');
}

export function bookScansKeyboard(runs = [], { page = 0, total = 0 } = {}) {
  const { pages, safe } = pageMeta(total, page);
  const kb = new InlineKeyboard();
  for (const r of runs.slice(0, BOOK_PAGE_SIZE)) {
    const label = truncate(relativeFa(r.at), 22);
    kb.text(`🔍 ${label}`, `book:sr:${r.id}:0`).row();
  }
  paginateRow(kb, { prefix: 'book:sc', page: safe, pages });
  backBookRow(kb);
  return kb;
}

export function formatBookScanRun(run, items = [], { page = 0 } = {}) {
  if (!run) return 'اسکن پیدا نشد.';
  const total = (run.projectIds || []).length;
  const { pages, safe } = pageMeta(total, page);
  const lines = [
    '🔍 جزئیات اسکن',
    '————————',
    '',
    `⏱ ${relativeFa(run.at)}`,
    `بررسی ${faNum(run.examined)} · جدید ${faNum(run.newCount)} · منطبق ${faNum(run.matched)}`,
    run.skipped ? `رد شده: ${run.summary?.reason || '—'}` : null,
    '',
  ].filter((l) => l != null);
  if (!items.length) {
    lines.push(emptyFa('scan_run'));
    return lines.join('\n');
  }
  lines.push(`فرصت‌های این اسکن · صفحه ${faNum(safe + 1)} از ${faNum(pages)}`, '');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    lines.push(
      `${faNum(safe * BOOK_PAGE_SIZE + i + 1)}) ${truncate(it.title || it.id, 40)} · ⭐ ${it.score != null ? faNum(it.score) : '—'}`
    );
  }
  return lines.join('\n');
}

export function bookScanRunKeyboard(run, items = [], { page = 0 } = {}) {
  const total = (run?.projectIds || []).length;
  const { pages, safe } = pageMeta(total, page);
  const kb = new InlineKeyboard();
  for (const it of items.slice(0, BOOK_PAGE_SIZE)) {
    kb.text(oppListLabel(it), `book:op:${it.id}`).row();
  }
  if (run?.id && pages > 1) {
    paginateRow(kb, { prefix: `book:sr:${run.id}`, page: safe, pages });
  }
  kb.text('🔍 اسکن‌ها', 'book:sc:0').text('📚 کتاب', 'book:home').row();
  kb.text('🏠 خانه', 'nav:home');
  return kb;
}

/**
 * Detail card for book — reuses notify format + control buttons.
 */
export function formatBookOppDetail(row) {
  if (!row) return 'فرصت پیدا نشد.';
  const card = {
    opportunity: row.opportunity || row,
    score: row.score,
    reasons: row.scoreReasons || [],
    decision: row.decision,
  };
  const body = formatOpportunityNotify(card);
  const extra = [
    '',
    `📌 وضعیت: ${stateFa(row.state)}`,
    row.firstSeenAt ? `🆕 اولین دید: ${relativeFa(row.firstSeenAt)}` : null,
    row.lastSeenAt ? `👁 آخرین دید: ${relativeFa(row.lastSeenAt)}` : null,
  ].filter(Boolean);
  return `${body}\n${extra.join('\n')}`;
}

export function bookOppDetailKeyboard(projectId) {
  // Same HITL controls as live notify card + back to book
  const kb = opportunityCardKeyboard(projectId);
  // opportunityCardKeyboard already ends with home — insert book before by rebuilding lightly
  return new InlineKeyboard()
    .text('📝 پیش‌نویس پیشنهاد', `opp:draft:${projectId}`)
    .text('✅ بفرست تأییدها', `opp:bidreq:${projectId}`)
    .row()
    .text('⏭ رد / نادیده', `opp:ignore:${projectId}`)
    .text('🔎 جزئیات', `opp:view:${projectId}`)
    .row()
    .text('📚 کتاب', 'book:home')
    .text('🏠 خانه', 'nav:home');
}

function draftStatusFa(s) {
  switch (s) {
    case 'pending':
      return 'آماده';
    case 'approved':
      return 'تأیید شده';
    case 'rejected':
      return 'رد شده';
    case 'stale':
      return 'منقضی';
    default:
      return String(s || '—');
  }
}

function stateFa(s) {
  switch (s) {
    case 'NEW':
      return 'جدید';
    case 'ANALYZED':
      return 'بررسی‌شده';
    case 'MATCHED':
      return 'منطبق';
    case 'IGNORED':
      return 'نادیده';
    case 'ACTION_CREATED':
      return 'اقدام شده';
    case 'SUBMITTED':
      return 'ارسال‌شده';
    case 'WON':
      return 'برنده';
    default:
      return String(s || '—');
  }
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function relativeFa(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso || '—');
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return 'همین الان';
  if (mins < 60) return `${faNum(mins)} دقیقه پیش`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${faNum(hours)} ساعت پیش`;
  return new Date(t).toLocaleString('fa-IR');
}

export default {
  BOOK_PAGE_SIZE,
  BOOK_NEW_WITHIN_HOURS,
  parseBookCallback,
  formatBookHome,
  bookHomeKeyboard,
  formatBookOppList,
  bookOppListKeyboard,
  formatBookActions,
  bookActionsKeyboard,
  formatBookDrafts,
  bookDraftsKeyboard,
  formatBookDraftDetail,
  bookDraftDetailKeyboard,
  formatBookScans,
  bookScansKeyboard,
  formatBookScanRun,
  bookScanRunKeyboard,
  formatBookOppDetail,
  bookOppDetailKeyboard,
};
