/**
 * Smart Bid: human Persian bid text + suggested price/timeline from opportunity + scoring profile.
 * Deterministic template + cleanHumanReply; no robotic dumps; no live submit here.
 * Tone follows PERSIAN_WRITING_RULES in src/agent/prompts.js (formal-but-human; no LLM prompt here).
 */
import { cleanHumanReply } from '../agent/reply-clean.js';

/**
 * @param {object} opportunity — ProjectOpportunity or store row fields
 * @param {object} [profile] — scoring profile
 * @param {{ score?: number, reasons?: string[], ownerNote?: string }} [opts]
 * @returns {{
 *   text: string,
 *   price: number|null,
 *   days: number|null,
 *   previewFa: string,
 *   meta: object,
 * }}
 */
export function buildSmartBid(opportunity, profile = {}, opts = {}) {
  const opp = opportunity?.opportunity && typeof opportunity.opportunity === 'object'
    ? { ...opportunity, ...opportunity.opportunity }
    : opportunity || {};
  const title = String(opp.title || '').trim();
  const skills = toList(opp.skills).slice(0, 5);
  const preferred = toList(profile.preferredSkills);
  const hitSkills = preferred.filter((ps) =>
    skills.some((os) => os.includes(ps) || ps.includes(os))
  );
  const category = opp.category != null ? String(opp.category) : '';
  const budgetMin = num(opp.budgetMin);
  const budgetMax = num(opp.budgetMax);
  const mid =
    budgetMin != null && budgetMax != null
      ? (budgetMin + budgetMax) / 2
      : budgetMax ?? budgetMin;

  const price = suggestPrice(mid, budgetMin, budgetMax, profile);
  const days = suggestDays(opp, skills, mid);

  const lines = [];
  lines.push('سلام، وقت بخیر.');

  if (title) {
    lines.push('شرح پروژه را خواندم و با نیاز کار هم‌راستا به نظر می‌رسد.');
  } else {
    lines.push('جزئیات درخواست را مرور کردم.');
  }

  if (hitSkills.length) {
    lines.push(
      `روی ${hitSkills.slice(0, 3).join(' و ')} تجربه دارم و می‌توانم کار را شفاف و مرحله‌به‌مرحله جلو ببرم.`
    );
  } else if (skills.length) {
    lines.push(
      `با مهارت‌های اعلام‌شده (${skills.slice(0, 3).join('، ')}) می‌توانم کمک کنم و خروجی قابل اتکا تحویل بدهم.`
    );
  } else {
    lines.push('می‌توانم روی همین موضوع کمک کنم و کار را منظم جلو ببرم.');
  }

  lines.push(
    'رویکرد من: اول خروجی و فرضیات را جمع‌بندی می‌کنیم، بعد روی زمان‌بندی و جزئیات اجرا توافق می‌کنیم.'
  );

  if (price != null) {
    lines.push(`پیشنهاد مالی اولیه حدود ${formatToman(price)} است.`);
  }
  if (days != null) {
    lines.push(`از نظر زمان، حدود ${toFa(days)} روز کاری تخمین می‌زنم.`);
  }

  lines.push('اگر موافقید بفرمایید تا جزئیات را دقیق‌تر مرور کنیم.');

  if (opts.ownerNote && String(opts.ownerNote).trim()) {
    const note = String(opts.ownerNote).trim().slice(0, 280);
    if (note && !/پیش‌نویس|auto|mock/i.test(note)) {
      lines.push(note);
    }
  }

  const text = cleanHumanReply(lines.filter(Boolean).join('\n'));
  const score = opts.score != null ? opts.score : null;
  const previewFa = [
    '📝 پیشنهاد هوشمند (پیش‌نمایش)',
    '————————',
    title ? `پروژه: ${truncate(title, 80)}` : `پروژه: ${opp.id || '—'}`,
    score != null ? `امتیاز: ${toFa(score)} / ۱۰۰` : null,
    category ? `دسته: ${category}` : null,
    price != null ? `قیمت پیشنهادی: ${formatToman(price)}` : 'قیمت پیشنهادی: —',
    days != null ? `زمان: حدود ${toFa(days)} روز` : 'زمان: —',
    '',
    'متن پیشنهاد:',
    text || '—',
    '',
    'ارسال زنده فقط پس از تأیید شما و از مسیر PermissionGate / قرارداد جهش.',
  ]
    .filter((l) => l != null)
    .join('\n');

  return {
    text,
    price,
    days,
    previewFa,
    meta: {
      projectId: opp.id != null ? String(opp.id) : null,
      hitSkills,
      cleaned: true,
      source: 'smart_bid',
      reasons: (opts.reasons || []).slice(0, 6),
    },
  };
}

function suggestPrice(mid, budgetMin, budgetMax, profile) {
  const pMin = num(profile.budgetMin);
  const pMax = num(profile.budgetMax);
  if (mid != null && Number.isFinite(mid) && mid > 0) {
    let price = Math.round(mid * 0.92);
    if (pMin != null && price < pMin) price = pMin;
    if (pMax != null && price > pMax) price = pMax;
    if (budgetMin != null && price < budgetMin) price = budgetMin;
    if (budgetMax != null && price > budgetMax) price = budgetMax;
    return Math.max(1, Math.round(price));
  }
  if (pMin != null && pMax != null) return Math.round((pMin + pMax) / 2);
  if (pMin != null) return pMin;
  if (budgetMin != null) return budgetMin;
  return null;
}

function suggestDays(opp, skills, mid) {
  let days = 7;
  if (opp?.isUrgent) days = 5;
  if (skills.length >= 4) days += 2;
  if (mid != null && mid >= 20_000_000) days += 3;
  if (mid != null && mid <= 2_000_000) days = Math.max(3, days - 2);
  return Math.max(3, Math.min(30, days));
}

function toList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatToman(n) {
  const numN = Number(n);
  if (!Number.isFinite(numN)) return String(n);
  try {
    return `${numN.toLocaleString('fa-IR')} تومان`;
  } catch {
    return `${numN} تومان`;
  }
}

function toFa(n) {
  try {
    return Number(n).toLocaleString('fa-IR');
  } catch {
    return String(n);
  }
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export default buildSmartBid;
