/**
 * Minimal Telegram UX for opportunities — cards + scan trigger.
 * Keeps main keyboard unchanged; adds callbacks under opp:* and a settings entry.
 */
import { InlineKeyboard } from 'grammy';

/**
 * @param {object} card
 * @param {{ opportunity: object, score?: number, reasons?: string[], decision?: string }} card
 */
export function formatOpportunityCard(card) {
  const o = card.opportunity || card;
  const budget =
    o.budgetMin != null || o.budgetMax != null
      ? `${faNum(o.budgetMin)} – ${faNum(o.budgetMax)}`
      : '—';
  const reasons = (card.reasons || o.scoreReasons || []).slice(0, 4);
  return [
    '🔥 فرصت جدید',
    '————————',
    o.title || `پروژه ${o.id}`,
    `💰 بودجه: ${budget}`,
    `⭐ امتیاز: ${card.score ?? o.score ?? '—'} / ۱۰۰`,
    `📌 تصمیم: ${decisionFa(card.decision || o.decision)}`,
    o.category ? `📂 دسته: ${o.category}` : null,
    (o.skills || []).length ? `🛠 ${(o.skills || []).slice(0, 5).join('، ')}` : null,
    '',
    'چرا؟',
    ...reasons.map((r) => `• ${r}`),
  ]
    .filter((l) => l != null)
    .join('\n');
}

export function opportunityCardKeyboard(projectId) {
  const id = String(projectId);
  return new InlineKeyboard()
    .text('📝 پیش‌نویس پیشنهاد', `opp:draft:${id}`)
    .text('👁 مشاهده', `opp:view:${id}`)
    .row()
    .text('🗑 نادیده', `opp:ignore:${id}`)
    .text('🏠 خانه', 'nav:home');
}

export function opportunitiesListKeyboard(items = [], { page = 0 } = {}) {
  const kb = new InlineKeyboard();
  for (const it of items.slice(0, 8)) {
    const label = `${it.score ?? '—'}｜${truncate(it.title || it.id, 28)}`;
    kb.text(label, `opp:view:${it.id}`).row();
  }
  kb.text('🔍 اسکن فرصت‌ها', 'opp:scan')
    .text('🔄 بروزرسانی', 'opp:list')
    .row()
    .text('📜 قوانین فرصت', 'opp:rules')
    .text('🏠 خانه', 'nav:home');
  void page;
  return kb;
}

export function opportunityRulesKeyboard(rules = []) {
  const kb = new InlineKeyboard();
  for (const r of rules.slice(0, 10)) {
    const mark = r.enabled ? '✅' : '⛔';
    kb.text(`${mark} ${truncate(r.name, 24)}`, `opp:rule:${r.ruleId || r.id}`).row();
  }
  kb.text('➕ نمونه قانون', 'opp:rule:sample')
    .text('🔍 اسکن', 'opp:scan')
    .row()
    .text('⬅️ فرصت‌ها', 'opp:list')
    .text('🏠 خانه', 'nav:home');
  return kb;
}

export function formatOpportunitiesHub(opts = {}) {
  const count = opts.count ?? 0;
  const lastScanAt = opts.lastScanAt || opts.lastScanAt || null;
  const scoringAvailable = Boolean(opts.scoringAvailable ?? opts.scoringAvailable);
  return [
    '🔥 فرصت‌های پروژه',
    '————————',
    '',
    `📦 فرصت‌های ذخیره‌شده: ${faNum(count)}`,
    `⏱ آخرین اسکن: ${lastScanAt ? relativeFa(lastScanAt) : 'هنوز انجام نشده'}`,
    `⭐ امتیازدهی: ${scoringAvailable ? 'فعال' : 'نیاز به پیکربندی پروفایل'}`,
    '',
    'اسکن پروژه‌های جدید کارلنسر را با دکمه زیر اجرا کنید.',
  ].join('\n');
}

export function formatOpportunityScanResult(summary = {}) {
  if (summary.skipped) {
    return `⏸ اسکن فرصت رد شد: ${summary.reason || '—'}`;
  }
  return [
    '🔍 نتیجه اسکن فرصت‌ها',
    '————————',
    `بررسی‌شده: ${faNum(summary.scanned ?? 0)}`,
    `جدید: ${faNum(summary.newCount ?? summary.newCount ?? 0)}`,
    `منطبق با قانون: ${faNum(summary.matched ?? 0)}`,
    `پیش‌نویس: ${faNum(summary.drafts ?? summary.drafts ?? 0)}`,
    `اطلاع‌رسانی: ${faNum(summary.notified ?? 0)}`,
    summary.errors?.length ? `خطاها: ${faNum(summary.errors.length)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOpportunityRule(rule) {
  if (!rule) return 'قانون پیدا نشد.';
  return [
    `📜 ${rule.name}`,
    `وضعیت: ${rule.enabled ? 'روشن' : 'خاموش'}`,
    `اولویت: ${rule.priority}`,
    `اقدام: ${rule.action}`,
    `شرایط: ${JSON.stringify(rule.conditions || [])}`,
  ].join('\n');
}

/**
 * @param {string} data
 * @returns {null|{ type: string, projectId?: string, ruleId?: string }}
 */
export function parseOpportunityCallback(data) {
  if (typeof data !== 'string' || !data.startsWith('opp:')) return null;
  if (data === 'opp:scan') return { type: 'opp_scan' };
  if (data === 'opp:list') return { type: 'opp_list' };
  if (data === 'opp:rules') return { type: 'opp_rules' };
  if (data === 'opp:rule:sample') return { type: 'opp_rule_sample' };
  let m = /^opp:view:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_view', projectId: m[1] };
  m = /^opp:draft:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_draft', projectId: m[1] };
  m = /^opp:ignore:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_ignore', projectId: m[1] };
  m = /^opp:rule:([0-9A-Za-z_-]{1,48})$/.exec(data);
  if (m) return { type: 'opp_rule_toggle', ruleId: m[1] };
  return null;
}

function decisionFa(d) {
  switch (d) {
    case 'IGNORE':
      return 'نادیده';
    case 'NOTIFY':
      return 'اطلاع‌رسانی';
    case 'CREATE_DRAFT':
      return 'پیش‌نویس پیشنهاد';
    case 'REQUEST_APPROVAL':
      return 'نیاز به تأیید';
    case 'AUTO_EXECUTE':
      return 'اجرای خودکار (mock)';
    default:
      return String(d || '—');
  }
}

function faNum(n) {
  if (n == null || n === '') return '—';
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

function relativeFa(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return 'همین الان';
  if (mins < 60) return `${faNum(mins)} دقیقه پیش`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${faNum(hours)} ساعت پیش`;
  return new Date(t).toLocaleString('fa-IR');
}

export default {
  formatOpportunityCard,
  opportunityCardKeyboard,
  opportunitiesListKeyboard,
  opportunityRulesKeyboard,
  formatOpportunitiesHub,
  formatOpportunityScanResult,
  formatOpportunityRule,
  parseOpportunityCallback,
};
