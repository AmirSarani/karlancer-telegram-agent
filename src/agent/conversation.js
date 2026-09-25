/**
 * Conversation helpers — build the real chat history (both sides) for the LLM,
 * detect own messages by sender id, and spot negotiation / portfolio questions.
 * Pure helpers; no network, no secrets.
 */

export const HISTORY_DEFAULT_MAX = 12;
export const HISTORY_DEFAULT_MAX_CHARS = 500;

/**
 * Resolve whether a message is ours.
 * Order: explicit flags (is_me/is_mine/from_me → isOwn) → sender id vs own user id.
 * @param {{ isOwn?: boolean|null, senderId?: string|null, userId?: string|null }} m
 * @param {string|null} ownUserId
 * @returns {boolean|null}
 */
export function resolveIsOwn(m, ownUserId) {
  if (!m) return null;
  if (m.isOwn === true || m.isOwn === false) return m.isOwn;
  const own = ownUserId != null && String(ownUserId).trim() !== '' ? String(ownUserId) : null;
  if (!own) return null;
  const sender = m.senderId ?? m.userId ?? null;
  if (sender == null || String(sender) === '') return null;
  return String(sender) === own;
}

/**
 * Return messages with isOwn filled from sender id when flags are missing.
 * @param {object[]} messages
 * @param {string|null} ownUserId
 */
export function markOwnMessages(messages = [], ownUserId = null) {
  return (messages || []).filter(Boolean).map((m) => {
    const isOwn = resolveIsOwn(m, ownUserId);
    return isOwn === m.isOwn ? m : { ...m, isOwn };
  });
}

function ts(m) {
  const t = Date.parse(m?.createdAt || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Sort oldest → newest (createdAt, then numeric id).
 * @param {object[]} messages
 */
export function sortChronological(messages = []) {
  return [...(messages || [])].filter(Boolean).sort((a, b) => {
    const ta = ts(a);
    const tb = ts(b);
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    const ia = Number(a.id);
    const ib = Number(b.id);
    if (Number.isFinite(ia) && Number.isFinite(ib)) return ia - ib;
    return 0;
  });
}

/**
 * Build a trimmed two-sided history for prompts.
 * @param {object[]} messages normalized messages (isOwn resolved when possible)
 * @param {{ max?: number, maxChars?: number }} [opts]
 * @returns {{ role: 'client'|'me'|'unknown', text: string, at: string|null }[]}
 */
export function buildConversationHistory(messages = [], opts = {}) {
  const max = Math.max(1, Math.min(40, Number(opts.max) || HISTORY_DEFAULT_MAX));
  const maxChars = Math.max(50, Number(opts.maxChars) || HISTORY_DEFAULT_MAX_CHARS);
  const sorted = sortChronological(messages).filter((m) => String(m.text || '').trim());
  return sorted.slice(-max).map((m) => {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim();
    return {
      role: m.isOwn === true ? 'me' : m.isOwn === false ? 'client' : 'unknown',
      text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
      at: m.createdAt || null,
    };
  });
}

/**
 * Client messages after our last message (the thing we must answer now).
 * Unknown-sender messages count as client (conservative for answering, not for sending).
 * @param {ReturnType<typeof buildConversationHistory>} history
 * @param {number} [max]
 */
export function latestClientTurn(history = [], max = 4) {
  const out = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role === 'me') break;
    out.unshift(h.text);
    if (out.length >= max) break;
  }
  return out;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toLatinDigits(s) {
  return String(s || '').replace(/[۰-۹٠-٩]/g, (ch) => {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) return String(p);
    return String(ARABIC_DIGITS.indexOf(ch));
  });
}

const DISCOUNT_RE = /تخفیف|گرون|گران|ارزون|ارزان|کمتر\s*(?:کنید|بشه|می‌?شه|میشه)|قیمت\s*(?:رو|را)?\s*(?:بیار|پایین)|بودجه\s*(?:م|ام)?\s*(?:کمه|کم\s*است)|discount|cheaper/i;
const PORTFOLIO_RE = /نمونه[\s\u200c-]*کار|رزومه|پورتفولیو|portfolio|نمونه\s*(?:سایت|پروژه)|کارهای\s*قبلی/i;

/**
 * Detect negotiation intent in the client's latest turn.
 * @param {string} text
 * @returns {{ askedDiscount: boolean, requestedPct: number|null, askedPortfolio: boolean, askedPrice: boolean, askedTime: boolean }}
 */
export function detectNegotiation(text) {
  const raw = String(text || '');
  const t = toLatinDigits(raw);
  const askedDiscount = DISCOUNT_RE.test(raw);
  let requestedPct = null;
  const m = t.match(/(\d{1,2}(?:\.\d+)?)\s*(?:٪|%|درصد)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 100) requestedPct = n;
  }
  return {
    askedDiscount: askedDiscount || (requestedPct != null && /تخفیف|کم/.test(raw)),
    requestedPct,
    askedPortfolio: PORTFOLIO_RE.test(raw),
    askedPrice: /قیمت|هزینه|بودجه|چقدر|چند\s*(?:میشه|می‌شود|تومن|تومان)|نرخ/.test(raw),
    askedTime: /کی\s*تحویل|زمان|چند\s*روز|چقدر\s*طول|مدت|تحویل/.test(raw),
  };
}

/**
 * Evaluate a discount request against owner limits.
 * @param {{ requestedPct: number|null, askedDiscount: boolean }} neg
 * @param {{ basePrice?: number|null, maxDiscountPct?: number, priceFloorToman?: number|null }} limits
 * @returns {{ allowed: boolean, needsOwner: boolean, reason: string|null, maxPct: number, minPrice: number|null }}
 */
export function evaluateDiscount(neg, limits = {}) {
  const maxPct = Number.isFinite(Number(limits.maxDiscountPct)) ? Number(limits.maxDiscountPct) : 10;
  const base = Number(limits.basePrice) > 0 ? Number(limits.basePrice) : null;
  const floor = Number(limits.priceFloorToman) > 0 ? Number(limits.priceFloorToman) : null;
  // Discount is relative to THIS job's own price. The optional global floor only protects jobs that
  // are priced above it, so a small cheap job (e.g. ~1M Toman) is never pushed up or rejected by it.
  const floorApplies = floor != null && base != null && base >= floor;
  let minPrice = base != null ? Math.round(base * (1 - maxPct / 100)) : null;
  if (floorApplies) minPrice = Math.max(minPrice, floor);
  if (!neg?.askedDiscount) {
    return { allowed: true, needsOwner: false, reason: null, maxPct, minPrice };
  }
  if (maxPct <= 0) {
    return { allowed: false, needsOwner: true, reason: 'discount_disabled', maxPct, minPrice };
  }
  if (neg.requestedPct != null && neg.requestedPct > maxPct) {
    return { allowed: false, needsOwner: true, reason: 'discount_over_limit', maxPct, minPrice };
  }
  if (base != null && floorApplies && neg.requestedPct != null) {
    const asked = Math.round(base * (1 - neg.requestedPct / 100));
    if (asked < floor) {
      return { allowed: false, needsOwner: true, reason: 'below_price_floor', maxPct, minPrice };
    }
  }
  return { allowed: true, needsOwner: false, reason: null, maxPct, minPrice };
}

export default {
  resolveIsOwn,
  markOwnMessages,
  sortChronological,
  buildConversationHistory,
  latestClientTurn,
  detectNegotiation,
  evaluateDiscount,
  toLatinDigits,
};
