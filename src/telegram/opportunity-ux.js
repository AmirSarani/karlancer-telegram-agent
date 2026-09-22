/**
 * Telegram UX for opportunities — hub, cards, scoring profile, rule editor, smart bid, decision inbox.
 */
import { InlineKeyboard } from 'grammy';
import {
  formatOpportunityNotify,
  formatOpportunityScanResultBody,
  formatBudgetCompact,
  formatSkillsChips,
  formatCategoryLine,
  formatWhyBullets,
  decisionLabelFa,
} from '../opportunity/format-notify.js';

/**
 * @param {object} card
 * @param {{ opportunity: object, score?: number, reasons?: string[], decision?: string }} card
 */
export function formatOpportunityCard(card) {
  // Same readable body as scan notify (buttons stay on keyboard separately).
  return formatOpportunityNotify(card);
}

export function opportunityCardKeyboard(projectId) {
  const id = String(projectId);
  return new InlineKeyboard()
    .text('📝 پیش‌نویس پیشنهاد', `opp:draft:${id}`)
    .text('✅ بفرست تأییدها', `opp:bidreq:${id}`)
    .row()
    .text('⏭ رد / نادیده', `opp:ignore:${id}`)
    .text('🔎 جزئیات', `opp:view:${id}`)
    .row()
    .text('🏠 خانه', 'nav:home');
}

/** Cap for batch «پیش‌نویس همهٔ منطبق» from scan summary. */
export const OPP_BATCH_PREP_CAP = 5;

/**
 * Inline controls on «نتیجه اسکن فرصت‌ها» — owner can jump to list / approvals / batch HITL prep.
 * @param {object} [summary]
 */
export function opportunityScanResultKeyboard(summary = {}) {
  const matched = Number(summary.matched ?? 0) || 0;
  const drafts = Number(summary.drafts ?? 0) || 0;
  const approvals = Number(summary.approvals ?? 0) || 0;
  const notified = Number(summary.notified ?? 0) || 0;
  const showBatch = matched > 0 || drafts > 0 || notified > 0;
  const kb = new InlineKeyboard()
    .text('🔥 فرصت‌ها', 'opp:list')
    .text('✅ تأییدها', 'goto:approvals')
    .row();
  if (showBatch) {
    kb.text('📝 پیش‌نویس همهٔ منطبق', 'opp:prep_matched').row();
  }
  kb.text('🏠 خانه', 'nav:home').text('⚙️ قوانین امتیاز', 'opp:profile');
  void approvals;
  return kb;
}

/**
 * Fuller project view for «🔎 جزئیات».
 * @param {object} card
 */
export function formatOpportunityDetails(card) {
  const o = card.opportunity || card;
  const reasons = formatWhyBullets(card.reasons || o.scoreReasons || [], { max: 6 });
  const client = o.client || {};
  const clientBits = [
    client.name || client.username || null,
    client.rate != null ? `★ ${client.rate}` : null,
    client.country || null,
  ].filter(Boolean);
  const desc = String(o.description || o.desc || '').trim();
  const descLine = desc
    ? desc.length > 280
      ? `${desc.slice(0, 279)}…`
      : desc
    : null;
  const score = card.score ?? o.score ?? '—';
  return [
    '🔎 جزئیات فرصت',
    '',
    o.title || `پروژه ${o.id}`,
    `🆔 ${o.id}`,
    '',
    `💰 ${formatBudgetCompact(o.budgetMin, o.budgetMax)}`,
    `⭐ ${faNum(score)} از ۱۰۰ · ${decisionLabelFa(card.decision || o.decision)}`,
    formatCategoryLine(o.category),
    formatSkillsChips(o.skills, { max: 8 }),
    clientBits.length ? `👤 کارفرما: ${clientBits.join(' · ')}` : null,
    o.ageHours != null ? `⏱ سن تقریبی: ${faNum(o.ageHours)} ساعت` : null,
    o.source ? `📥 منبع: ${o.source}` : null,
    '',
    descLine ? 'توضیح:' : null,
    descLine,
    reasons.length ? '' : null,
    reasons.length ? 'چرا این امتیاز؟' : null,
    ...reasons,
  ]
    .filter((l) => l != null)
    .join('\n');
}

export function smartBidKeyboard(projectId) {
  const id = String(projectId);
  return new InlineKeyboard()
    .text('✅ بفرست تأییدها', `opp:bidreq:${id}`)
    .row()
    .text('✏️ ویرایش متن', `opp:bidedit:${id}`)
    .text('⬅️ فرصت', `opp:view:${id}`)
    .row()
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
    .text('👤 پروفایل امتیاز', 'opp:profile')
    .text('📜 قوانین فرصت', 'opp:rules')
    .row()
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
  kb.text('➕ قانون جدید', 'opp:rule:new')
    .text('📌 نمونه', 'opp:rule:sample')
    .row()
    .text('⬅️ فرصت‌ها', 'opp:list')
    .text('🏠 خانه', 'nav:home');
  return kb;
}

export function opportunityRuleDetailKeyboard(ruleId) {
  const id = String(ruleId);
  return new InlineKeyboard()
    .text('🔌 روشن/خاموش', `opp:rule:tog:${id}`)
    .text('✏️ ویرایش', `opp:rule:edit:${id}`)
    .row()
    .text('🗑 حذف', `opp:rule:del:${id}`)
    .text('⬅️ قوانین', 'opp:rules')
    .row()
    .text('🏠 خانه', 'nav:home');
}

export function scoringProfileKeyboard(profile = {}) {
  const configured = Boolean(
    (profile.preferredSkills || []).length ||
      (profile.preferredCategories || []).length ||
      profile.budgetMin != null ||
      profile.budgetMax != null
  );
  return new InlineKeyboard()
    .text('🛠 مهارت‌ها', 'opp:prof:skills')
    .text('💰 بودجه', 'opp:prof:budget')
    .row()
    .text('📂 دسته‌ها', 'opp:prof:cats')
    .text(configured ? '✅ پیکربندی‌شده' : '⚠️ ناقص', 'opp:profile')
    .row()
    .text('⬅️ فرصت‌ها', 'opp:list')
    .text('🏠 خانه', 'nav:home');
}

export function formatScoringProfile(profile = {}) {
  const skills = profile.preferredSkills || [];
  const cats = profile.preferredCategories || [];
  return [
    '👤 پروفایل امتیازدهی مالک',
    '————————',
    '',
    `🛠 مهارت‌های ترجیحی: ${skills.length ? skills.join('، ') : '— (تنظیم نشده)'}`,
    `📂 دسته‌ها: ${cats.length ? cats.join('، ') : '—'}`,
    `💰 بودجه: ${faNum(profile.budgetMin)} – ${faNum(profile.budgetMax)}`,
    `⏱ تازگی (ساعت): ${faNum(profile.freshHours ?? 24)}`,
    '',
    skills.length || cats.length || profile.budgetMin != null
      ? '⭐ امتیازدهی: فعال (scoringAvailable=true)'
      : '⭐ امتیازدهی: غیرفعال — حداقل مهارت یا بودجه را تنظیم کنید.',
    '',
    'برای ویرایش، دکمه‌های زیر را بزنید و متن را طبق راهنما بفرستید.',
    'لغو: /cancel',
  ].join('\n');
}

export function formatOpportunitiesHub(opts = {}) {
  const count = opts.count ?? 0;
  const lastScanAt = opts.lastScanAt || null;
  const scoringAvailable = Boolean(opts.scoringAvailable);
  return [
    '🔥 فرصت‌های پروژه',
    '————————',
    '',
    `📦 فرصت‌های ذخیره‌شده: ${faNum(count)}`,
    `⏱ آخرین اسکن: ${lastScanAt ? relativeFa(lastScanAt) : 'هنوز انجام نشده'}`,
    `⭐ امتیازدهی: ${scoringAvailable ? 'فعال' : 'نیاز به پیکربندی پروفایل'}`,
    '',
    'از منوی اصلی «🔥 فرصت‌ها» هم می‌توانید برگردید.',
    'اسکن پروژه‌های جدید را با دکمه زیر اجرا کنید.',
  ].join('\n');
}

export function formatOpportunityScanResult(summary = {}) {
  return formatOpportunityScanResultBody(summary);
}

export function formatOpportunityRule(rule) {
  if (!rule) return 'قانون پیدا نشد.';
  const conds = (rule.conditions || [])
    .map((c) => `${c.field} ${c.op} ${formatCondValue(c.value)}${c.valueTo != null ? `…${c.valueTo}` : ''}`)
    .join(' | ');
  return [
    `📜 ${rule.name}`,
    `وضعیت: ${rule.enabled ? 'روشن' : 'خاموش'}`,
    `اولویت: ${rule.priority}`,
    `اقدام: ${actionFa(rule.action)}`,
    `شرایط: ${conds || '—'}`,
  ].join('\n');
}

export function formatRuleEditorHelp() {
  return [
    '➕ ساخت قانون فرصت',
    '————————',
    '',
    'یک خط با این قالب بفرستید:',
    '',
    'نام | کلیدواژه۱،کلیدواژه۲ | بودجه_حداقل | اقدام',
    '',
    'اقدامها: پیش‌نویس | اطلاع | نادیده | تأیید | خودکار',
    '',
    'مثال:',
    'وردپرس خوب | وردپرس،wordpress | 5000000 | پیش‌نویس',
    '',
    'لغو: /cancel',
  ].join('\n');
}

/**
 * Parse owner-typed rule line into createRule args.
 * @param {string} text
 */
export function parseRuleCreateText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length < 2) {
    return { ok: false, error: 'format', hint: 'حداقل نام و کلیدواژه لازم است' };
  }
  const name = parts[0].slice(0, 80);
  const keywords = parts[1]
    .split(/[,،]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const budgetMin = parts[2] && /^\d+$/.test(parts[2].replace(/,/g, ''))
    ? Number(parts[2].replace(/,/g, ''))
    : null;
  const actionToken = (parts[3] || parts[2] || 'پیش‌نویس').trim();
  const action = mapActionFa(actionToken);
  if (!name || !keywords.length) {
    return { ok: false, error: 'incomplete' };
  }
  /** @type {object[]} */
  const conditions = [{ field: 'skills', op: 'has_any', value: keywords }];
  // Also match title keywords
  conditions.push({ field: 'title', op: 'contains', value: keywords[0] });
  // OR is not supported — use has_any on skills primarily; drop title if too strict?
  // Better: only skills has_any + optional budget
  const conds = [{ field: 'skills', op: 'has_any', value: keywords }];
  if (budgetMin != null) {
    conds.push({ field: 'budgetMin', op: 'gte', value: budgetMin });
  }
  // Allow title OR skills via single contains on title as alternative rule — keep skills primary
  void conditions;
  return {
    ok: true,
    rule: {
      name,
      action,
      priority: 50,
      enabled: true,
      conditions: conds,
    },
  };
}

function mapActionFa(token) {
  const t = String(token || '').toLowerCase();
  if (/نادیده|ignore/.test(t)) return 'IGNORE';
  if (/اطلاع|notify/.test(t)) return 'NOTIFY';
  if (/تأیید|تاید|approval/.test(t)) return 'REQUEST_APPROVAL';
  if (/خودکار|auto/.test(t)) return 'AUTO_EXECUTE';
  return 'CREATE_BID_DRAFT';
}

function actionFa(a) {
  switch (a) {
    case 'IGNORE':
      return 'نادیده';
    case 'NOTIFY':
      return 'اطلاع‌رسانی';
    case 'CREATE_BID_DRAFT':
      return 'پیش‌نویس پیشنهاد';
    case 'REQUEST_APPROVAL':
      return 'درخواست تأیید';
    case 'AUTO_EXECUTE':
      return 'اجرای خودکار محدود';
    default:
      return String(a || '—');
  }
}

/**
 * Decision inbox — unified queue view.
 */
export function formatDecisionInbox(opts = {}) {
  const opps = opts.opportunities || [];
  const approvals = opts.approvals || [];
  const messages = opts.messages || [];
  const lines = [
    '📥 صندوق تصمیم',
    '————————',
    '',
    `🔥 فرصت‌ها: ${faNum(opps.length)}`,
    `✅ تأیید باز: ${faNum(approvals.length)}`,
    messages.length ? `💬 پیام اولویت: ${faNum(messages.length)}` : null,
    '',
  ].filter((l) => l != null);

  if (!opps.length && !approvals.length && !messages.length) {
    lines.push('صندوق خالی است — فعلاً تصمیمی لازم نیست.');
    return lines.join('\n');
  }

  if (opps.length) {
    lines.push('— فرصت‌های برتر —');
    for (const o of opps.slice(0, 5)) {
      lines.push(`• [${o.score ?? '—'}] ${truncate(o.title || o.id, 40)}`);
    }
    lines.push('');
  }
  if (approvals.length) {
    lines.push('— تأییدهای باز —');
    for (const a of approvals.slice(0, 5)) {
      lines.push(`• ${truncate(a.label || a.action || a.approval_id, 40)}`);
    }
    lines.push('');
  }
  if (messages.length) {
    lines.push('— پیام‌های اولویت —');
    for (const m of messages.slice(0, 3)) {
      lines.push(`• ${truncate(m.label || m.guestName || m.roomId, 40)}`);
    }
  }
  return lines.join('\n');
}

export function decisionInboxKeyboard(opts = {}) {
  const kb = new InlineKeyboard()
    .text('🔥 فرصت‌ها', 'opp:list')
    .text('✅ تأییدها', 'goto:approvals')
    .row()
    .text('💬 مهم‌ها', 'goto:unread')
    .text('🔄 بروزرسانی', 'inbox:refresh')
    .row()
    .text('🏠 خانه', 'nav:home');
  void opts;
  return kb;
}

/**
 * Morning digest text — quiet if nothing.
 * @returns {string|null} null when quiet
 */
export function formatMorningDigest(opts = {}) {
  const nOpp = Number(opts.opportunityCount || 0);
  const nAppr = Number(opts.pendingApprovals || 0);
  const sessionOk = opts.sessionHealthy;
  if (nOpp === 0 && nAppr === 0 && opts.force !== true) {
    return null; // quiet
  }
  const sessionLine =
    sessionOk === true
      ? 'نشست: سالم ✅'
      : sessionOk === false
        ? 'نشست: ناسالم ❌ — تمدید نشست را بزنید'
        : 'نشست: نامشخص';
  return [
    '🌅 صبح بخیر — خلاصه روزانه',
    '————————',
    `${faNum(nOpp)} فرصت · ${faNum(nAppr)} تأیید · ${sessionLine}`,
    opts.lastScanAt ? `آخرین اسکن فرصت: ${relativeFa(opts.lastScanAt)}` : null,
    '',
    '📥 صندوق تصمیم را برای جزئیات باز کنید.',
  ]
    .filter((l) => l != null)
    .join('\n');
}

/**
 * @param {string} data
 * @returns {null|{ type: string, projectId?: string, ruleId?: string, field?: string }}
 */
export function parseOpportunityCallback(data) {
  if (typeof data !== 'string' || !data.startsWith('opp:')) return null;
  if (data === 'opp:scan') return { type: 'opp_scan' };
  if (data === 'opp:list') return { type: 'opp_list' };
  if (data === 'opp:rules') return { type: 'opp_rules' };
  if (data === 'opp:rule:sample') return { type: 'opp_rule_sample' };
  if (data === 'opp:rule:new') return { type: 'opp_rule_new' };
  if (data === 'opp:profile') return { type: 'opp_profile' };
  if (data === 'opp:prep_matched') return { type: 'opp_prep_matched' };
  if (data === 'opp:prof:skills') return { type: 'opp_prof_edit', field: 'skills' };
  if (data === 'opp:prof:budget') return { type: 'opp_prof_edit', field: 'budget' };
  if (data === 'opp:prof:cats') return { type: 'opp_prof_edit', field: 'cats' };
  let m = /^opp:view:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_view', projectId: m[1] };
  m = /^opp:draft:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_draft', projectId: m[1] };
  m = /^opp:smart:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_smart', projectId: m[1] };
  m = /^opp:bidreq:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_bidreq', projectId: m[1] };
  m = /^opp:bidedit:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_bidedit', projectId: m[1] };
  m = /^opp:ignore:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_ignore', projectId: m[1] };
  m = /^opp:reject:([0-9A-Za-z_-]{1,32})$/.exec(data);
  if (m) return { type: 'opp_reject', projectId: m[1] };
  m = /^opp:rule:tog:([0-9A-Za-z_-]{1,48})$/.exec(data);
  if (m) return { type: 'opp_rule_toggle', ruleId: m[1] };
  m = /^opp:rule:edit:([0-9A-Za-z_-]{1,48})$/.exec(data);
  if (m) return { type: 'opp_rule_edit', ruleId: m[1] };
  m = /^opp:rule:del:([0-9A-Za-z_-]{1,48})$/.exec(data);
  if (m) return { type: 'opp_rule_delete', ruleId: m[1] };
  m = /^opp:rule:([0-9A-Za-z_-]{1,48})$/.exec(data);
  if (m) return { type: 'opp_rule_view', ruleId: m[1] };
  return null;
}

export function parseInboxCallback(data) {
  if (data === 'inbox:refresh') return { type: 'inbox_refresh' };
  if (data === 'goto:inbox') return { type: 'goto_inbox' };
  return null;
}

function decisionFa(d) {
  return decisionLabelFa(d);
}

function formatCondValue(v) {
  if (Array.isArray(v)) return v.join('،');
  return String(v ?? '');
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
  opportunityScanResultKeyboard,
  formatOpportunityDetails,
  OPP_BATCH_PREP_CAP,
  smartBidKeyboard,
  opportunitiesListKeyboard,
  opportunityRulesKeyboard,
  opportunityRuleDetailKeyboard,
  scoringProfileKeyboard,
  formatScoringProfile,
  formatOpportunitiesHub,
  formatOpportunityScanResult,
  formatOpportunityRule,
  formatRuleEditorHelp,
  parseRuleCreateText,
  formatDecisionInbox,
  decisionInboxKeyboard,
  formatMorningDigest,
  parseOpportunityCallback,
  parseInboxCallback,
};
