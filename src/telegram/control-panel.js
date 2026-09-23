/**
 * Telegram control panel façades — thin wrappers over existing adapters / stores / MCP-equivalent reads.
 * Owner-only UX; never print tokens/passwords/Authorization.
 */
import { InlineKeyboard } from 'grammy';
import { listVerifiedMutations } from '../api/contracts/verified-mutation.js';
import { checkTokenHealth } from '../security/token-health.js';
import { createAgentSettingsStore, listAutomationAudit, getTodayAutoCounts } from './agent-settings.js';
import { createOpportunityStore } from '../opportunity/store.js';
import { isScoringConfigured } from '../opportunity/scoring.js';
import { readLiveAutoBidFlag } from './live-auto-flag.js';
import { redactString } from '../security/redaction.js';
import { toFaNum, formatRelativeTime } from './scan-ux.js';

function modeLabelFa(mode) {
  if (mode === 'assisted') return '🟡 کمکی';
  if (mode === 'auto') return '🔴 خودکار';
  return '🟢 دستی';
}

function navRow(kb, { back = 'cp:hub', home = true } = {}) {
  if (back) kb.text('⬅️ بازگشت', back);
  if (home) kb.text('🏠 خانه', 'nav:home');
  return kb;
}

/** Callback vocabulary for control panel (≤64 bytes). */
export const CP = Object.freeze({
  HUB: 'cp:hub',
  SYS: 'cp:sys',
  EYES: 'cp:eyes',
  BRAIN: 'cp:brain',
  HANDS: 'cp:hands',
  SEC: 'cp:sec',
  NOTIF: 'cp:notif',
  AUDIT: 'cp:audit',
  HELP: 'cp:help',
  EYES_DASH: 'eyes:dash',
  EYES_PROF: 'eyes:prof',
  EYES_NOTIF: 'eyes:notif',
  EYES_BM: 'eyes:bm',
  EYES_PLANS: 'eyes:plans',
  EYES_SEARCH: 'eyes:search',
  EYES_SEO: 'eyes:seo',
  EYES_CHATS: 'goto:chats',
  BRAIN_OPP: 'opp:hub',
  BRAIN_PROF: 'opp:profile',
  BRAIN_RULES: 'opp:rules',
  BRAIN_SCAN: 'opp:scan',
  BRAIN_HIST: 'brain:hist',
  HANDS_APPR: 'goto:approvals',
  HANDS_MODE: 'nav:mode',
  HANDS_TOG: 'nav:toggles',
  HANDS_LIMITS: 'hands:lim',
  HANDS_BL: 'hands:bl',
  HANDS_LIVE: 'hands:live',
  HANDS_LIVE_ON: 'hands:live:on',
  HANDS_LIVE_OFF: 'hands:live:off',
  NOTIF_DIGEST: 'notif:digest',
  NOTIF_BALE: 'notif:bale',
  NOTIF_BALE_SET: 'notif:bale:set',
  NOTIF_BALE_CLR: 'notif:bale:clr',
  SEC_RELOGIN: 'set:relogin',
  POSTWIN: 'nav:postwin',
});

/**
 * Parse control-panel callback_data. Returns null if not a CP callback.
 * @param {string} data
 */
export function parseControlCallback(data) {
  if (typeof data !== 'string' || !data) return null;
  const map = {
    [CP.HUB]: { type: 'cp_hub' },
    [CP.SYS]: { type: 'cp_sys' },
    [CP.EYES]: { type: 'cp_eyes' },
    [CP.BRAIN]: { type: 'cp_brain' },
    [CP.HANDS]: { type: 'cp_hands' },
    [CP.SEC]: { type: 'cp_sec' },
    [CP.NOTIF]: { type: 'cp_notif' },
    [CP.AUDIT]: { type: 'cp_audit' },
    [CP.HELP]: { type: 'cp_help' },
    [CP.EYES_DASH]: { type: 'eyes_dash' },
    [CP.EYES_PROF]: { type: 'eyes_prof' },
    [CP.EYES_NOTIF]: { type: 'eyes_notif' },
    [CP.EYES_BM]: { type: 'eyes_bm' },
    [CP.EYES_PLANS]: { type: 'eyes_plans' },
    [CP.EYES_SEARCH]: { type: 'eyes_search' },
    [CP.EYES_SEO]: { type: 'eyes_seo' },
    [CP.BRAIN_HIST]: { type: 'brain_hist' },
    [CP.HANDS_LIMITS]: { type: 'hands_limits' },
    [CP.HANDS_BL]: { type: 'hands_blacklist' },
    [CP.HANDS_LIVE]: { type: 'hands_live' },
    [CP.HANDS_LIVE_ON]: { type: 'hands_live_on' },
    [CP.HANDS_LIVE_OFF]: { type: 'hands_live_off' },
    [CP.NOTIF_DIGEST]: { type: 'notif_digest' },
    [CP.NOTIF_BALE]: { type: 'notif_bale' },
    [CP.NOTIF_BALE_SET]: { type: 'notif_bale_set' },
    [CP.NOTIF_BALE_CLR]: { type: 'notif_bale_clear' },
  };
  return map[data] || null;
}

function backHome(kb, back = CP.HUB) {
  kb.row();
  navRow(kb, { back, refresh: null, home: true });
  return kb;
}

export function controlHubKeyboard() {
  const kb = new InlineKeyboard()
    .text('🖥 سیستم', CP.SYS)
    .text('👁 خواندن داده', CP.EYES)
    .row()
    .text('🧠 مغز', CP.BRAIN)
    .text('🖐 عملیات', CP.HANDS)
    .row()
    .text('🔐 امنیت', CP.SEC)
    .text('🔔 اعلان‌ها', CP.NOTIF)
    .row()
    .text('📜 تاریخچه', CP.AUDIT)
    .text('🏆 پس از برد', CP.POSTWIN)
    .row()
    .text('❓ نقشه', CP.HELP)
    .text('⚙️ تنظیمات اجرا', 'nav:set');
  backHome(kb, 'nav:home');
  return kb;
}

export function eyesMenuKeyboard() {
  const kb = new InlineKeyboard()
    .text('📊 خلاصه داشبورد', CP.EYES_DASH)
    .text('👤 پروفایل', CP.EYES_PROF)
    .row()
    .text('💬 گفتگوها', CP.EYES_CHATS)
    .text('🔔 اعلان‌های کارلنسر', CP.EYES_NOTIF)
    .row()
    .text('🔖 نشان‌ها', CP.EYES_BM)
    .text('📋 پلن‌ها', CP.EYES_PLANS)
    .row()
    .text('🔎 جستجوی پروژه', CP.EYES_SEARCH)
    .text('📁 فایل SEO', CP.EYES_SEO);
  backHome(kb);
  return kb;
}

export function brainMenuKeyboard() {
  const kb = new InlineKeyboard()
    .text('🔥 فرصت‌ها', CP.BRAIN_OPP)
    .text('📚 کتاب فرصت‌ها', 'book:home')
    .row()
    .text('👤 پروفایل امتیاز', CP.BRAIN_PROF)
    .text('📜 قوانین فرصت', CP.BRAIN_RULES)
    .row()
    .text('📡 اسکن فرصت', CP.BRAIN_SCAN)
    .text('🗂 تاریخچه تصمیم', CP.BRAIN_HIST)
    .row()
    .text('📥 صندوق تصمیم', 'goto:inbox');
  backHome(kb);
  return kb;
}

export function handsMenuKeyboard(liveOn = false) {
  const kb = new InlineKeyboard()
    .text('✅ تأییدها', CP.HANDS_APPR)
    .text('🎛 حالت اجرا', CP.HANDS_MODE)
    .row()
    .text('🎚 سوئیچ‌ها', CP.HANDS_TOG)
    .text(liveOn ? '⚡ پیشنهاد زنده: روشن' : '⚡ پیشنهاد زنده: خاموش', CP.HANDS_LIVE)
    .row()
    .text('📏 سقف روزانه', CP.HANDS_LIMITS)
    .text('🚫 لیست سیاه', CP.HANDS_BL)
    .row()
    .text('🛑 توقف اضطراری', 'set:emerg');
  backHome(kb);
  return kb;
}

export function securityMenuKeyboard() {
  const kb = new InlineKeyboard()
    .text('🔐 تمدید نشست', CP.SEC_RELOGIN)
    .text('🔄 بروزرسانی', CP.SEC)
    .row();
  backHome(kb);
  return kb;
}

export function notifMenuKeyboard(baleConfigured = false) {
  const kb = new InlineKeyboard()
    .text('☀️ ارسال خلاصه الآن', CP.NOTIF_DIGEST)
    .row()
    .text(baleConfigured ? '📱 بله: تنظیم‌شده' : '📱 بله: تنظیم نشده', CP.NOTIF_BALE)
    .row();
  if (baleConfigured) {
    kb.text('🗑 پاک کردن توکن بله', CP.NOTIF_BALE_CLR).row();
  } else {
    kb.text('➕ تنظیم توکن بله', CP.NOTIF_BALE_SET).row();
  }
  backHome(kb);
  return kb;
}

export function liveAutoConfirmKeyboard(enable) {
  const kb = new InlineKeyboard();
  if (enable) {
    kb.text('⚠️ بله، روشن کن', CP.HANDS_LIVE_ON)
      .row()
      .text('❌ انصراف', CP.HANDS_LIVE);
  } else {
    kb.text('🔒 خاموش کن', CP.HANDS_LIVE_OFF)
      .row()
      .text('❌ انصراف', CP.HANDS_LIVE);
  }
  backHome(kb, CP.HANDS);
  return kb;
}

export function limitsKeyboard() {
  const kb = new InlineKeyboard()
    .text('✏️ ویرایش سقف‌ها', 'wiz:limits')
    .row();
  backHome(kb, CP.HANDS);
  return kb;
}

export function blacklistKeyboard() {
  const kb = new InlineKeyboard()
    .text('✏️ ویرایش کلیدواژه‌ها', 'wiz:bl_kw')
    .row()
    .text('✏️ ویرایش اتاق‌ها', 'wiz:bl_rooms')
    .row();
  backHome(kb, CP.HANDS);
  return kb;
}

export function formatControlHub() {
  return [
    '🖥 کنترل سیستم',
    '————————',
    '',
    'همه‌چیز از اینجا — بدون نیاز به Cursor برای کارهای روزانه.',
    '',
    '• 🖥 سیستم — سلامت، حالت، قراردادها',
    '• 👁 خواندن داده — داشبورد، پروفایل، اعلان، نشان، پلن، جستجو',
    '• 🧠 مغز — فرصت، امتیاز، قانون، اسکن، تاریخچه',
    '• 🖐 عملیات — تأیید، حالت، سوئیچ، سقف، لیست سیاه',
    '• 🔐 امنیت — نشست و مالکان',
    '• 🔔 اعلان‌ها — خلاصه صبح و بله',
    '• 📜 تاریخچه — رویدادهای اخیر',
    '',
    'یک بخش را انتخاب کنید ↓',
  ].join('\n');
}

/**
 * @param {object} s
 */
export function formatSystemOverview(s = {}) {
  const contracts = Array.isArray(s.contracts) ? s.contracts : [];
  const auth =
    s.karlancerAuth === true ? '✅ متصل' : s.karlancerAuth === false ? '❌ قطع' : '❔ نامشخص';
  const mcpAuth = s.mcpApiKeySet ? '🔑 کلید تنظیم شده' : '🔓 بدون کلید (فقط لوکال)';
  const live = s.liveAutoBid ? '⚡ روشن (خطرناک)' : '🔒 خاموش (پیش‌فرض)';
  const bale = s.baleConfigured ? '✅ تنظیم‌شده' : '— تنظیم نشده';
  const mode = modeLabelFa(s.executionMode || 'manual');
  const lines = [
    '🖥 نمای سیستم',
    '————————',
    '',
    '💚 سلامت',
    `• ایجنت: ${s.state === 'paused' ? '⏸ مکث' : '▶️ فعال'}`,
    `• کارلنسر: ${auth}`,
    s.emergencyStop ? '• 🛑 توقف اضطراری فعال' : '• توقف اضطراری: خاموش',
    '',
    '🎛 اجرا',
    `• حالت: ${mode}`,
    `• پیشنهاد زنده: ${live}`,
    `• امروز خودکار: پیام ${toFaNum(s.autoToday?.messages ?? 0)} · پیشنهاد ${toFaNum(s.autoToday?.bids ?? 0)}`,
    '',
    '🔌 کنترل از راه دور',
    `• درگاه MCP: ${s.mcpHost || '—'}:${toFaNum(s.mcpPort ?? '—')}`,
    `• احراز MCP: ${mcpAuth}`,
    `• قراردادهای تأییدشده: ${toFaNum(contracts.length)}`,
  ];
  if (contracts.length) {
    lines.push(`• قابلیت‌ها: ${contracts.map((c) => c.capability || c).slice(0, 6).join('، ')}`);
  } else {
    lines.push('• هنوز قراردادی ثبت نشده — ارسال/پیشنهاد زنده قفل است');
  }
  lines.push('', '📱 بله', `• وضعیت: ${bale}`, '', 'مالکان (شناسه):', `• ${(s.ownerIds || []).map(toFaNum).join('، ') || '—'}`);
  return lines.join('\n');
}

export function formatEyesMenu() {
  return [
    '👁 خواندن داده',
    '————————',
    '',
    'مشاهدهٔ زنده از کارلنسر — بدون تغییر.',
    '',
    'یک مورد را باز کنید ↓',
  ].join('\n');
}

export function formatBrainMenu() {
  return [
    '🧠 مغز',
    '————————',
    '',
    'فرصت‌ها، امتیازدهی، قوانین و تصمیم‌ها.',
    '',
    'یک مورد را باز کنید ↓',
  ].join('\n');
}

export function formatHandsMenu(s = {}) {
  const live = s.liveAutoBid ? '⚡ روشن' : '🔒 خاموش';
  return [
    '🖐 عملیات',
    '————————',
    '',
    `• حالت: ${modeLabelFa(s.executionMode || 'manual')}`,
    `• پیشنهاد زنده: ${live}`,
    s.emergencyStop ? '• 🛑 توقف اضطراری فعال — بر همه چیز غلبه می‌کند' : '• توقف اضطراری: خاموش',
    '',
    'تأییدها، سوئیچ‌ها، سقف و لیست سیاه از اینجا.',
  ].join('\n');
}

export function formatDashboardSummary(data = {}) {
  const u = data.user || {};
  const w = data.wallet || {};
  const stats = data.stats || {};
  const name = u.displayName || u.name || u.username || '—';
  const lines = [
    '📊 خلاصه داشبورد کارلنسر',
    '————————',
    '',
    `• نام: ${String(name).slice(0, 60)}`,
    u.id != null ? `• شناسه: ${toFaNum(u.id)}` : null,
    w.balance != null || w.credit != null
      ? `• کیف پول: ${toFaNum(w.balance ?? w.credit ?? '—')}`
      : '• کیف پول: —',
  ].filter(Boolean);
  const keys = Object.keys(stats).slice(0, 6);
  if (keys.length) {
    lines.push('', '📈 آمار');
    for (const k of keys) {
      const v = stats[k];
      if (v != null && typeof v !== 'object') lines.push(`• ${k}: ${toFaNum(v)}`);
    }
  }
  lines.push('', 'داده‌ها خلاصه شده‌اند؛ جزئیات خام نشان داده نمی‌شود.');
  return lines.join('\n');
}

export function formatProfileCard(me = {}) {
  const u = me.user || {};
  return [
    '👤 پروفایل (امن)',
    '————————',
    '',
    `• نام: ${String(u.displayName || u.name || u.username || '—').slice(0, 60)}`,
    me.id != null ? `• شناسه: ${toFaNum(me.id)}` : u.id != null ? `• شناسه: ${toFaNum(u.id)}` : '• شناسه: —',
    u.phone ? '• تلفن: ثبت‌شده (مخفی)' : '• تلفن: —',
    `• منبع: ${me.source === 'har_dashboard' ? 'داشبورد' : me.status || '—'}`,
    '',
    'اطلاعات حساس نمایش داده نمی‌شود.',
  ].join('\n');
}

export function formatNotificationsCard(list = [], { page = 1 } = {}) {
  const lines = ['🔔 اعلان‌های کارلنسر', '————————', '', `صفحه ${toFaNum(page)} · ${toFaNum(list.length)} مورد`, ''];
  if (!list.length) {
    lines.push('اعلانی نیست یا نشست نیاز به تمدید دارد.');
    return lines.join('\n');
  }
  for (const n of list.slice(0, 8)) {
    const title = String(n.title || n.message || n.body || n.type || 'اعلان').slice(0, 80);
    const when = n.createdAt || n.created_at || n.date;
    lines.push(`• ${title}${when ? ` (${formatRelativeTime(when)})` : ''}`);
  }
  if (list.length > 8) lines.push('', `… و ${toFaNum(list.length - 8)} مورد دیگر`);
  return lines.join('\n');
}

export function formatBookmarksCard({ projects = [], freelancers = [] } = {}) {
  return [
    '🔖 نشان‌ها',
    '————————',
    '',
    `• پروژه‌ها: ${toFaNum(projects.length)}`,
    projects.length ? `  ${projects.slice(0, 12).map((id) => toFaNum(id)).join('، ')}` : '  —',
    '',
    `• فریلنسرها: ${toFaNum(freelancers.length)}`,
    freelancers.length ? `  ${freelancers.slice(0, 12).map((id) => toFaNum(id)).join('، ')}` : '  —',
  ].join('\n');
}

export function formatPlansCard(plans = []) {
  const lines = ['📋 پلن‌ها', '————————', '', `تعداد: ${toFaNum(plans.length)}`, ''];
  if (!plans.length) {
    lines.push('پلنی یافت نشد.');
    return lines.join('\n');
  }
  for (const p of plans.slice(0, 10)) {
    const name = p.name || p.title || p.id || 'پلن';
    const id = p.id != null ? ` (#${toFaNum(p.id)})` : '';
    lines.push(`• ${String(name).slice(0, 50)}${id}`);
  }
  return lines.join('\n');
}

export function formatProjectSearchPrompt() {
  return [
    '🔎 جستجوی پروژه',
    '————————',
    '',
    'یک کلمه یا عبارت بفرستید (مثلاً: ربات تلگرام).',
    'لغو: /cancel',
  ].join('\n');
}

export function formatProjectSearchResults(projects = [], query = '') {
  const lines = [
    '🔎 نتیجه جستجو',
    '————————',
    '',
    `عبارت: «${String(query).slice(0, 40)}»`,
    `تعداد: ${toFaNum(projects.length)}`,
    '',
  ];
  if (!projects.length) {
    lines.push('چیزی پیدا نشد.');
    return lines.join('\n');
  }
  for (const p of projects.slice(0, 8)) {
    const title = String(p.title || p.name || 'پروژه').slice(0, 60);
    const budget =
      p.budgetMin != null || p.budgetMax != null
        ? ` · بودجه ${toFaNum(p.budgetMin ?? '?')}–${toFaNum(p.budgetMax ?? '?')}`
        : '';
    const id = p.id != null ? `#${toFaNum(p.id)} ` : '';
    lines.push(`• ${id}${title}${budget}`);
  }
  return lines.join('\n');
}

export function formatSeoMetaPrompt() {
  return [
    '📁 متای فایل SEO',
    '————————',
    '',
    'فقط نام فایل عمومی (بدون مسیر و ..).',
    'مثال: banner.webp',
    'آدرس خصوصی برنمی‌گردد.',
    'لغو: /cancel',
  ].join('\n');
}

export function formatSeoMetaCard(meta = {}) {
  return [
    '📁 متای SEO',
    '————————',
    '',
    `• نام: ${meta.name || '—'}`,
    `• مسیر راهنما: ${meta.pathHint || '—'}`,
    `• نوع: ${meta.kind || '—'}`,
    meta.note ? `• نکته: ${meta.note}` : null,
    '',
    'آدرس دانلود خصوصی نمایش داده نمی‌شود.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatDecisionHistory(rows = []) {
  const lines = ['🗂 تاریخچه تصمیم', '————————', '', `نمایش ${toFaNum(rows.length)} مورد اخیر`, ''];
  if (!rows.length) {
    lines.push('هنوز تصمیمی ثبت نشده. اسکن فرصت را اجرا کنید.');
    return lines.join('\n');
  }
  for (const r of rows.slice(0, 12)) {
    const score = r.score != null ? toFaNum(r.score) : '—';
    const dec = r.decision || '—';
    const pid = r.projectId != null ? toFaNum(r.projectId) : '—';
    const when = r.createdAt ? formatRelativeTime(r.createdAt) : '';
    lines.push(`• #${pid} · ${dec} · امتیاز ${score}${when ? ` · ${when}` : ''}`);
  }
  return lines.join('\n');
}

export function formatLiveAutoCard(enabled) {
  if (enabled) {
    return [
      '⚡ پیشنهاد خودکار زنده',
      '————————',
      '',
      'وضعیت: 🟢 روشن',
      '',
      'هشدار: در حالت خودکار و با قانون/سقف، پیشنهاد ممکن است بدون تأیید جداگانه ارسال شود.',
      'توقف اضطراری همچنان همه را قطع می‌کند.',
      '',
      'برای خاموش کردن دکمه زیر را بزنید.',
    ].join('\n');
  }
  return [
    '⚡ پیشنهاد خودکار زنده',
    '————————',
    '',
    'وضعیت: 🔒 خاموش (پیش‌فرض امن)',
    '',
    'با روشن کردن، مسیر «پیشنهاد خودکار زنده» فعال می‌شود.',
    '⚠️ این کار خطرناک است — فقط اگر مطمئنید.',
    '',
    'حتی با روشن بودن:',
    '• توقف اضطراری برنده است',
    '• بدون قرارداد تأییدشده ارسال نمی‌شود',
    '• سقف روزانه و قوانین الزامی‌اند',
    '',
    'برای روشن کردن، تأیید قوی لازم است.',
  ].join('\n');
}

export function formatLiveAutoWarningConfirm() {
  return [
    '⚠️ تأیید روشن‌کردن پیشنهاد زنده',
    '————————',
    '',
    'مطمئنید؟ پیشنهادها ممکن است به‌صورت خودکار ثبت شوند.',
    'این تنظیم در حافظه و env ذخیره می‌شود.',
    'هر زمان می‌توانید خاموش کنید یا توقف اضطراری بزنید.',
  ].join('\n');
}

export function formatLimitsCard(s = {}) {
  const lim = s.limits || {};
  const today = s.autoToday || {};
  return [
    '📏 سقف روزانه',
    '————————',
    '',
    `• سقف پیام خودکار: ${toFaNum(lim.maxAutoMessagesPerDay ?? 5)}`,
    `• سقف پیشنهاد خودکار: ${toFaNum(lim.maxAutoBidsPerDay ?? 10)}`,
    '',
    'امروز مصرف‌شده:',
    `• پیام: ${toFaNum(today.messages ?? 0)}`,
    `• پیشنهاد: ${toFaNum(today.bids ?? 0)}`,
    '',
    'برای ویرایش، دکمه زیر را بزنید و دو عدد بفرستید:',
    'مثال: ۵ ۱۰',
  ].join('\n');
}

export function formatBlacklistCard(s = {}) {
  const bl = s.blacklist || {};
  return [
    '🚫 لیست سیاه',
    '————————',
    '',
    `• اتاق‌ها: ${(bl.rooms || []).length ? (bl.rooms || []).slice(0, 15).map(toFaNum).join('، ') : '—'}`,
    `• کاربران: ${(bl.users || []).length ? (bl.users || []).slice(0, 15).map(toFaNum).join('، ') : '—'}`,
    `• کلیدواژه‌ها: ${(bl.keywords || []).length ? (bl.keywords || []).slice(0, 20).join('، ') : '—'}`,
    '',
    'ویرایش ساده با دکمه‌های زیر (لیست با ویرگول).',
  ].join('\n');
}

export function formatSecurityCard(s = {}) {
  const th = s.tokenHealth || {};
  const auth =
    s.karlancerAuth === true ? '✅ سالم' : s.karlancerAuth === false ? '❌ منقضی/نامعتبر' : '❔ نامشخص';
  return [
    '🔐 امنیت',
    '————————',
    '',
    `• نشست کارلنسر: ${auth}`,
    th.ageDays != null ? `• سن تقریبی توکن: ${toFaNum(Math.floor(th.ageDays))} روز` : '• سن توکن: نامشخص',
    th.warn && th.reasonFa ? `• هشدار: ${th.reasonFa}` : '• هشدار سن: ندارد',
    '',
    'مالکان (فقط شناسه):',
    `• ${(s.ownerIds || []).map(toFaNum).join('، ') || '—'}`,
    '',
    'تمدید: ترجیحاً توکن مرورگر — رمز فقط پشتیبان و خطرناک در چت.',
    'رمز/توکن هرگز اینجا چاپ نمی‌شود.',
  ].join('\n');
}

export function formatNotifSettingsCard(s = {}) {
  return [
    '🔔 اعلان‌ها',
    '————————',
    '',
    '☀️ خلاصه صبح (~۰۹:۰۰ تهران) برای همه مالکان ارسال می‌شود.',
    `• مالکان تلگرام: ${toFaNum((s.ownerIds || []).length)} نفر`,
    '',
    '📱 بله (پیام‌رسان موازی):',
    `• وضعیت: ${s.baleConfigured ? '✅ تنظیم‌شده' : '— تنظیم نشده'}`,
    '',
    'توکن بله هرگز در چت تکرار نمی‌شود؛ پس از دریافت پیام پاک می‌شود.',
  ].join('\n');
}

export function formatBaleSetPrompt() {
  return [
    '📱 تنظیم توکن بله',
    '————————',
    '',
    'توکن ربات بله را همین‌جا بفرستید.',
    'پس از دریافت، پیام شما حذف می‌شود و توکن هرگز تکرار نمی‌شود.',
    'لغو: /cancel',
  ].join('\n');
}

export function formatAuditCards(rows = []) {
  const lines = ['📜 تاریخچه عملیات', '————————', '', `آخرین ${toFaNum(rows.length)} رویداد`, ''];
  if (!rows.length) {
    lines.push('هنوز رویدادی ثبت نشده.');
    return lines.join('\n');
  }
  for (const r of rows.slice(0, 15)) {
    const action = auditActionFa(r.action, r.tool);
    const code = r.result_code || r.resultCode || '';
    const when = r.created_at || r.createdAt;
    const emoji = code === 'ok' || code === 'allowed' || code === 'approved' ? '✅' : code === 'denied' || code === 'rejected' ? '🚫' : '•';
    lines.push(`${emoji} ${action}${when ? ` · ${formatRelativeTime(when)}` : ''}`);
  }
  return lines.join('\n');
}

function auditActionFa(action, tool) {
  const a = String(action || '');
  const map = {
    'auto.messages.send': 'ارسال پیام خودکار',
    'auto.bids.submit': 'پیشنهاد خودکار',
    'auto.notifications.mark_read': 'خواندن اعلان خودکار',
    'auto.messages.mark_seen': 'علامت خوانده‌شده',
    'messages.send': 'ارسال پیام',
    'bids.submit': 'ثبت پیشنهاد',
    emergency_stop: 'توقف اضطراری',
    mode_change: 'تغییر حالت',
  };
  if (map[a]) return map[a];
  if (a.startsWith('opportunity.')) return `تصمیم فرصت: ${a.slice(13)}`;
  if (a.startsWith('auto.')) return a.replace(/^auto\./, 'خودکار: ').replace(/[._]/g, ' ');
  if (tool === 'permission_gate') return `دروازه: ${a.replace(/[._]/g, ' ').slice(0, 40)}`;
  return (a || tool || 'رویداد').replace(/[._]/g, ' ').slice(0, 48);
}

export function formatControlHelp() {
  return [
    '❓ نقشه کنترل سیستم',
    '————————',
    '',
    'بدون اصطلاح فنی — فقط کار روزمره:',
    '',
    '🖥 سیستم → آیا همه‌چیز سالم است؟',
    '👁 خواندن → دیدن داشبورد و گفتگو و اعلان',
    '🧠 مغز → پیدا کردن و امتیاز دادن به پروژه‌ها',
    '🖐 عملیات → تأیید، حالت، سقف، پیشنهاد زنده',
    '🔐 امنیت → نشست و مالکان',
    '🔔 اعلان‌ها → خلاصه صبح و بله',
    '📜 تاریخچه → چه اتفاقی افتاد',
    '🏆 پس از برد → کارهای بعد از برد پروژه',
    '',
    '⚠️ تلگرام E2E واقعی نیست — سرور تلگرام محتوا را می‌بیند.',
    'توکن و رمز را در چت نگه ندارید.',
  ].join('\n');
}

/**
 * Collect system overview snapshot (no secrets).
 */
export function collectSystemOverview({
  db,
  api,
  runtime,
  owners = [],
  mcpHost,
  mcpPort,
  mcpApiKeySet = false,
  baleConfigured = false,
  envDefaultLive = false,
  envFile = null,
} = {}) {
  const settings = db ? createAgentSettingsStore(db).get() : null;
  const autoToday = db ? getTodayAutoCounts(db) : {};
  const contracts = listVerifiedMutations().map((c) => ({
    capability: c.capability,
    method: c.method,
  }));
  const liveAutoBid = readLiveAutoBidFlag(db, { envDefault: envDefaultLive });
  return {
    state: runtime?.state || 'running',
    karlancerAuth: api?.client?.hasAuth != null ? Boolean(api.client.hasAuth) : null,
    emergencyStop: Boolean(settings?.emergencyStop),
    executionMode: settings?.mode || 'manual',
    autoToday,
    contracts,
    liveAutoBid,
    baleConfigured: Boolean(baleConfigured),
    mcpHost: mcpHost || '127.0.0.1',
    mcpPort: mcpPort ?? 8787,
    mcpApiKeySet: Boolean(mcpApiKeySet),
    ownerIds: (owners || []).map(Number).filter(Number.isFinite),
    envFile: envFile ? String(envFile).split('/').pop() : null,
  };
}

/**
 * Recent audit rows: permission_gate + opportunity decisions + general audit_log.
 */
export function collectAuditRows(db, { limit = 20 } = {}) {
  if (!db) return [];
  const n = Math.min(50, Math.max(1, limit));
  try {
    const rows = db
      .prepare(
        `SELECT id, actor, action, tool, result_code, created_at, detail_json
         FROM audit_log
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(n);
    return rows;
  } catch {
    return listAutomationAudit(db, { limit: n, actionPrefix: '' });
  }
}

/**
 * @param {object} deps
 */
export async function fetchEyesDashboard(api) {
  if (!api?.user?.dashboard) throw new Error('dashboard_unavailable');
  const data = await api.user.dashboard();
  const { raw, ...safe } = data;
  void raw;
  return safe;
}

export async function fetchEyesProfile(api) {
  if (!api?.user?.me) throw new Error('profile_unavailable');
  const me = await api.user.me();
  const { raw, ...safe } = me;
  void raw;
  return safe;
}

export async function fetchEyesNotifications(api, page = 1) {
  if (!api?.notifications?.list) throw new Error('notifications_unavailable');
  const data = await api.notifications.list({ page });
  return {
    page,
    notifications: (data.notifications || []).map(({ raw, ...n }) => {
      void raw;
      return n;
    }),
  };
}

export async function fetchEyesBookmarks(api) {
  const projects = api?.bookmarks?.projectIds ? await api.bookmarks.projectIds() : { ids: [] };
  const freelancers = api?.bookmarks?.freelancerIds
    ? await api.bookmarks.freelancerIds()
    : { ids: [] };
  return { projects: projects.ids || [], freelancers: freelancers.ids || [] };
}

export async function fetchEyesPlans(api) {
  if (!api?.plans?.list) throw new Error('plans_unavailable');
  const data = await api.plans.list();
  return (data.plans || []).map((p) => {
    if (p && typeof p === 'object') {
      const { raw, ...rest } = p;
      void raw;
      return rest;
    }
    return p;
  });
}

export async function fetchEyesSearch(api, query) {
  if (!api?.search?.projects && !api?.projects?.search) throw new Error('search_unavailable');
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return { projects: [], query: q };
  let data;
  if (api.search?.projects) {
    data = await api.search.projects({ q, query: q, search: q });
  } else {
    data = await api.projects.search({ q });
  }
  return {
    query: q,
    projects: (data.projects || []).map(({ raw, ...p }) => {
      void raw;
      return p;
    }),
  };
}

export async function fetchEyesSeoMeta(api, name) {
  if (!api?.files?.publicSeoMeta) throw new Error('seo_unavailable');
  return api.files.publicSeoMeta(name);
}

export function collectSecuritySnapshot({ api, owners = [], envFile = null } = {}) {
  const th = checkTokenHealth({
    authOk: api?.client?.hasAuth != null ? Boolean(api.client.hasAuth) : null,
    envFile,
  });
  return {
    karlancerAuth: api?.client?.hasAuth != null ? Boolean(api.client.hasAuth) : null,
    tokenHealth: th,
    ownerIds: (owners || []).map(Number).filter(Number.isFinite),
  };
}

export function collectBrainHistory(db, { limit = 15 } = {}) {
  if (!db) return [];
  const store = createOpportunityStore(db);
  return store.listDecisions({ limit });
}

export function scoringReady(db) {
  if (!db) return false;
  const store = createOpportunityStore(db);
  return isScoringConfigured(store.getScoringProfile());
}

/** Safe strip of any accidental secret-looking substrings in user-facing text. */
export function safeCardText(text) {
  return redactString(String(text || '')).slice(0, 3500);
}

export default {
  CP,
  parseControlCallback,
  controlHubKeyboard,
  formatControlHub,
};
