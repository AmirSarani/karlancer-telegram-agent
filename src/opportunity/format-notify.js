/**
 * Readable Telegram copy for opportunity cards / notify / scan summary.
 * Presentation only — does not change scoring or decisions.
 */

const ZERO_VALUE_REASON =
  /\(\+0\)|بدون امتیاز|پیکربندی نشده \(\+0\)|جزء امتیاز کارفرما صفر|این جزء امتیاز حذف شد|نامنطبق:.*\(\+0\)|خارج از بازه هدف|قدیمی‌تر از|هیچ مهارت ترجیحی منطبق نشد|پروژه مهارتی اعلام نکرده|سن آگهی مشخص نیست|دسته پروژه مشخص نیست|بودجه مشخص نیست/;

/**
 * @param {{ opportunity?: object, score?: number, reasons?: string[], decision?: string }|object} card
 */
export function formatOpportunityNotify(card) {
  const o = card?.opportunity || card || {};
  const score = card?.score ?? o.score ?? null;
  const decision = card?.decision || o.decision;
  const reasons = card?.reasons || o.scoreReasons || [];

  const title = String(o.title || `پروژه ${o.id || '—'}`).trim();
  const budget = formatBudgetCompact(o.budgetMin, o.budgetMax);
  const scoreBit =
    score != null && score !== ''
      ? `⭐ ${faNum(score)} از ۱۰۰`
      : '⭐ —';
  const decisionBit = decisionLabelShort(decision);
  const meta = [`💰 ${budget}`, `${scoreBit} · ${decisionBit}`].join('\n');

  const skillsLine = formatSkillsChips(o.skills);
  const categoryLine = formatCategoryLine(o.category);
  const why = formatWhyBullets(reasons);

  return [
    '🔥 فرصت جدید',
    '',
    title,
    '',
    meta,
    skillsLine,
    categoryLine,
    why.length ? '' : null,
    why.length ? 'چرا این امتیاز؟' : null,
    ...why,
  ]
    .filter((line) => line != null)
    .join('\n');
}

/**
 * Compact scan summary — fewer wall separators, scannable counts.
 * @param {object} [summary]
 */
export function formatOpportunityScanResultBody(summary = {}) {
  if (summary.skipped) {
    return `⏸ اسکن فرصت رد شد: ${summary.reason || '—'}`;
  }
  const bits = [
    `بررسی ${faNum(summary.scanned ?? 0)}`,
    `جدید ${faNum(summary.newCount ?? 0)}`,
    `منطبق ${faNum(summary.matched ?? 0)}`,
  ];
  const actions = [
    Number(summary.drafts) ? `پیش‌نویس ${faNum(summary.drafts)}` : null,
    Number(summary.approvals) ? `تأیید ${faNum(summary.approvals)}` : null,
    Number(summary.autoExecuted) ? `خودکار ${faNum(summary.autoExecuted)}` : null,
    Number(summary.notified) ? `اطلاع ${faNum(summary.notified)}` : null,
  ].filter(Boolean);

  return [
    '🔍 نتیجه اسکن فرصت‌ها',
    '',
    bits.join(' · '),
    actions.length ? actions.join(' · ') : 'اقدامی ثبت نشد',
    summary.errors?.length ? `⚠️ خطا: ${faNum(summary.errors.length)}` : null,
  ]
    .filter((l) => l != null)
    .join('\n');
}

/**
 * Short decision chip for meta line.
 * @param {string} [d]
 */
export function decisionLabelShort(d) {
  switch (d) {
    case 'IGNORE':
      return 'نادیده';
    case 'NOTIFY':
      return 'فقط خبر';
    case 'CREATE_DRAFT':
      return 'پیش‌نویس';
    case 'REQUEST_APPROVAL':
      return 'نیاز به تأیید';
    case 'AUTO_EXECUTE':
      return 'خودکار محدود';
    default:
      return d ? String(d) : '—';
  }
}

/**
 * Fuller decision label (details / legacy one-liners).
 * @param {string} [d]
 */
export function decisionLabelFa(d) {
  switch (d) {
    case 'IGNORE':
      return 'نادیده';
    case 'NOTIFY':
      return 'فقط خبر — می‌تونی پیش‌نویس بگیری';
    case 'CREATE_DRAFT':
      return 'پیش‌نویس پیشنهاد';
    case 'REQUEST_APPROVAL':
      return 'نیاز به تأیید';
    case 'AUTO_EXECUTE':
      return 'اجرای خودکار محدود';
    default:
      return String(d || '—');
  }
}

/**
 * @param {string[]|null|undefined} skills
 * @param {{ max?: number }} [opts]
 */
export function formatSkillsChips(skills, opts = {}) {
  const max = opts.max ?? 4;
  const list = Array.isArray(skills)
    ? skills.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (!list.length) return null;
  if (list.length <= max) {
    return `🛠 ${list.join('، ')}`;
  }
  const shown = list.slice(0, max);
  const rest = list.length - max;
  return `🛠 ${shown.join('، ')} و ${faNum(rest)} تا دیگر`;
}

/**
 * Soft-pedal raw numeric category ids; show readable names.
 * @param {string|number|null|undefined} category
 */
export function formatCategoryLine(category) {
  if (category == null || category === '') return null;
  const s = String(category).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return null; // raw id like «6» — skip noise
  return `📂 ${s}`;
}

/**
 * Filter zero-value noise; plain Persian preferred; max 4 bullets.
 * @param {string[]} reasons
 * @param {{ max?: number }} [opts]
 */
export function formatWhyBullets(reasons, opts = {}) {
  const max = opts.max ?? 4;
  const cleaned = [];
  for (const raw of reasons || []) {
    const r = String(raw || '').trim();
    if (!r) continue;
    if (ZERO_VALUE_REASON.test(r)) continue;
    const plain = softenReason(r);
    if (!plain) continue;
    if (cleaned.includes(plain)) continue;
    cleaned.push(plain);
    if (cleaned.length >= max) break;
  }
  return cleaned.map((r) => `• ${r}`);
}

/**
 * Strip (+points) spam; keep short human phrase.
 * @param {string} r
 */
function softenReason(r) {
  let s = r.replace(/\s*\(\+\d+\)\s*$/u, '').trim();
  // Drop verbose age decimals when we already say «خیلی تازه» / «تازه»
  s = s.replace(/\s*\(\d+(?:\.\d+)?\s*ساعت(?:،\s*آستانه\s*\d+س)?\)\s*/u, '').trim();
  s = s.replace(/\s{2,}/g, ' ').trim();
  // Known friendly shortenings
  if (/^مهارت‌های منطبق:/u.test(s)) return 'مهارت‌های مرتبط';
  if (/^مهارت‌ها اعلام شده‌اند/u.test(s)) return 'مهارت‌ها اعلام شده';
  if (/^بودجه در بازه هدف/u.test(s)) return 'بودجه در بازه هدف';
  if (/^بودجه اعلام‌شده:/u.test(s)) return 'بودجه مشخص';
  if (/^بودجه تا حدی هم‌پوشانی/u.test(s)) return 'بودجه هم‌پوشانی جزئی';
  if (/^دسته منطبق:/u.test(s)) {
    const name = s.replace(/^دسته منطبق:\s*/u, '').trim();
    return /^\d+$/u.test(name) ? 'دسته منطبق' : 'دسته منطبق';
  }
  if (/^دسته:\s*\d+$/u.test(s)) return null; // raw id — skip
  if (/^دسته:/u.test(s) && !/نامنطبق/u.test(s)) return 'دسته مشخص';
  if (/^خیلی تازه/u.test(s)) return 'آگهی خیلی تازه';
  if (/^تازه\b/u.test(s)) return 'آگهی تازه';
  if (/^زمان نسبی:/u.test(s)) return 'زمان نسبی مشخص';
  if (/^امتیاز کارفرما\b/u.test(s) && !/پایین/u.test(s)) return 'امتیاز کارفرما خوب';
  if (/امتیاز کارفرما پایین/u.test(s)) return 'امتیاز کارفرما پایین';
  if (/پروژه فوری/u.test(s)) return 'پروژه فوری';
  if (/تنظیم بازخورد مالک/u.test(s)) return s.replace(/\s*\(\+\d+\)\s*$/u, '').trim();
  // Decision-engine / rule reasons — keep short
  if (s.length > 72) s = `${s.slice(0, 71)}…`;
  return s;
}

/**
 * Compact budget: millions when both sides ≥ ۱M.
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 */
export function formatBudgetCompact(min, max) {
  const a = num(min);
  const b = num(max);
  if (a == null && b == null) return '—';
  if (a != null && b != null && a >= 1e6 && b >= 1e6) {
    const lo = faNum(Math.round(a / 1e6));
    const hi = faNum(Math.round(b / 1e6));
    return lo === hi ? `${lo} میلیون تومان` : `${lo}–${hi} میلیون تومان`;
  }
  if (a != null && b != null) {
    return `${faNum(a)}–${faNum(b)} تومان`;
  }
  const v = a ?? b;
  if (v >= 1e6) return `${faNum(Math.round(v / 1e6))} میلیون تومان`;
  return `${faNum(v)} تومان`;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function faNum(n) {
  if (n == null || n === '') return '—';
  try {
    return Number(n).toLocaleString('fa-IR');
  } catch {
    return String(n);
  }
}

export default formatOpportunityNotify;
