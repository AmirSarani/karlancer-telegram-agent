/**
 * Telegram wizards for the auto-message rule and chat pricing limits.
 * Owner writes simple Persian lines; Persian/Arabic digits accepted.
 */
import { toLatinDigits } from '../agent/conversation.js';

const CLEAR_WORDS = new Set(['پاک', 'هیچ', 'حذف', '-', '—', 'خالی', 'none']);

function splitLines(text) {
  return String(text || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function keyValue(line) {
  const m = line.match(/^([^:：]+)[:：]\s*(.*)$/);
  if (!m) return null;
  return { key: m[1].trim(), value: m[2].trim() };
}

function isClear(v) {
  return CLEAR_WORDS.has(String(v || '').trim().toLowerCase());
}

function parseNumber(v) {
  const t = toLatinDigits(String(v || '')).replace(/[,٬،\s]/g, '').replace(/[٪%]/g, '');
  const m = t.match(/^\d+(\.\d+)?$/);
  return m ? Number(t) : null;
}

export const MESSAGE_RULE_WIZARD_HELP = [
  '✏️ معیار پیام خودکار',
  '',
  'هر معیار را در یک خط بفرستید (هر کدام اختیاری است):',
  'کلیدواژه: وردپرس، سئو',
  'حداقل بودجه: ۵۰۰۰۰۰۰',
  'حداقل اطمینان: ۷۰',
  '',
  'برای پاک کردن یک معیار بنویسید «پاک»؛ مثلاً «کلیدواژه: پاک».',
  'اگر هیچ معیاری نگذارید، فقط پاسخ‌هایی خودکار می‌روند که اطمینان هوش مصنوعی به آن‌ها دست‌کم ۶۰٪ باشد.',
  'لغو: /cancel',
].join('\n');

export const PRICING_WIZARD_HELP = [
  '💸 سقف تخفیف و کف قیمت',
  '',
  'در یک یا دو خط بفرستید:',
  'تخفیف: ۱۰',
  'کف قیمت: ۳۰۰۰۰۰۰',
  '',
  'عدد تخفیف درصد است و کف قیمت به تومان. «کف قیمت: پاک» یعنی بدون کف.',
  'اگر کارفرما بیشتر از این تخفیف بخواهد، جواب خودکار نمی‌رود و از شما می‌پرسم.',
  'لغو: /cancel',
].join('\n');

/**
 * @param {string} text
 * @returns {{ ok: boolean, patch?: object, errors: string[] }}
 */
export function parseMessageRuleWizard(text) {
  const patch = {};
  const errors = [];
  for (const line of splitLines(text)) {
    const kv = keyValue(line);
    if (!kv) {
      errors.push(`این خط را متوجه نشدم: «${line.slice(0, 40)}»`);
      continue;
    }
    const k = kv.key;
    if (/کلید/.test(k)) {
      patch.keywords = isClear(kv.value)
        ? []
        : kv.value.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 30);
    } else if (/بودجه/.test(k)) {
      if (isClear(kv.value)) patch.budgetMin = null;
      else {
        const n = parseNumber(kv.value);
        if (n == null || n < 0) errors.push('حداقل بودجه باید عدد باشد.');
        else patch.budgetMin = Math.round(n);
      }
    } else if (/اطمینان|امتیاز/.test(k)) {
      if (isClear(kv.value)) patch.matchScoreThreshold = null;
      else {
        const n = parseNumber(kv.value);
        if (n == null || n < 0 || n > 100) errors.push('حداقل اطمینان باید عددی بین ۰ تا ۱۰۰ باشد.');
        else patch.matchScoreThreshold = Math.round(n);
      }
    } else {
      errors.push(`معیار «${k.slice(0, 20)}» را نمی‌شناسم.`);
    }
  }
  const ok = errors.length === 0 && Object.keys(patch).length > 0;
  if (!Object.keys(patch).length && !errors.length) errors.push('هیچ معیاری پیدا نشد.');
  return { ok, patch: ok ? patch : undefined, errors };
}

/**
 * @param {string} text
 * @returns {{ ok: boolean, patch?: object, errors: string[] }}
 */
export function parsePricingWizard(text) {
  const patch = {};
  const errors = [];
  for (const line of splitLines(text)) {
    const kv = keyValue(line);
    if (!kv) {
      errors.push(`این خط را متوجه نشدم: «${line.slice(0, 40)}»`);
      continue;
    }
    if (/تخفیف/.test(kv.key)) {
      const n = isClear(kv.value) ? 0 : parseNumber(kv.value);
      if (n == null || n < 0 || n > 50) errors.push('سقف تخفیف باید درصدی بین ۰ تا ۵۰ باشد.');
      else patch.maxDiscountPct = n;
    } else if (/کف/.test(kv.key)) {
      if (isClear(kv.value)) patch.priceFloorToman = null;
      else {
        const n = parseNumber(kv.value);
        if (n == null || n <= 0) errors.push('کف قیمت باید عدد (تومان) باشد.');
        else patch.priceFloorToman = Math.round(n);
      }
    } else {
      errors.push(`«${kv.key.slice(0, 20)}» را نمی‌شناسم.`);
    }
  }
  const ok = errors.length === 0 && Object.keys(patch).length > 0;
  if (!Object.keys(patch).length && !errors.length) errors.push('چیزی برای ذخیره پیدا نشد.');
  return { ok, patch: ok ? patch : undefined, errors };
}

export default { parseMessageRuleWizard, parsePricingWizard, MESSAGE_RULE_WIZARD_HELP, PRICING_WIZARD_HELP };
