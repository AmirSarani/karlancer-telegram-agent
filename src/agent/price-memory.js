/**
 * Price learning (Phase C). All amounts are Toman (Karlancer budgets are Toman).
 *
 * - Samples: owner-approved answers to «چه قیمتی بدهم؟» and prices actually sent in chat.
 * - Features: category, keyword tags, scope size, days.
 * - learnedPriceFor(): median of similar past prices; `confident` when ≥ minSamples and low spread.
 * - Per-room owner answer + pending ask live in kv.
 */
import { toLatinDigits } from './conversation.js';

export const LEARN_MIN_SAMPLES = 5;
export const LEARN_MAX_SPREAD = 0.35;
export const SIMILARITY_MIN = 0.5;
const MAX_AMOUNT = 100_000_000_000; // 100B Toman sanity cap
const MIN_AMOUNT = 100_000;

/** Canonical tag → trigger words (Persian + English). */
const TAGS = Object.freeze({
  wordpress: ['وردپرس', 'wordpress', 'ووکامرس', 'woocommerce', 'المنتور', 'elementor'],
  shop: ['فروشگاه', 'فروشگاهی', 'shop', 'ecommerce', 'درگاه', 'سبد خرید'],
  landing: ['لندینگ', 'صفحه فرود', 'landing', 'تک صفحه'],
  corporate: ['شرکتی', 'رزومه', 'معرفی'],
  seo: ['سئو', 'seo'],
  app: ['اپلیکیشن', 'اندروید', 'android', 'ios', 'flutter', 'فلاتر', 'react native', 'موبایل'],
  bot: ['ربات', 'bot', 'بات'],
  telegram: ['تلگرام', 'telegram', 'بله', 'bale'],
  design: ['ui', 'ux', 'فیگما', 'figma', 'رابط کاربری', 'لوگو', 'گرافیک'],
  backend: ['api', 'وب‌سرویس', 'وب سرویس', 'بک‌اند', 'بک اند', 'backend', 'node', 'django', 'laravel', 'لاراول', 'دیتابیس'],
  frontend: ['react', 'ری‌اکت', 'vue', 'next', 'فرانت'],
  content: ['محتوا', 'ترجمه', 'مقاله', 'تولید محتوا'],
  scraping: ['اسکرپ', 'scrap', 'crawler', 'خزنده', 'استخراج داده'],
  ai: ['هوش مصنوعی', 'chatgpt', 'llm', 'یادگیری ماشین', 'openai'],
  fix: ['رفع باگ', 'باگ', 'bug', 'رفع مشکل', 'پشتیبانی'],
  panel: ['پنل', 'داشبورد', 'dashboard', 'مدیریت'],
});

/**
 * @param {{ project?: object, analysis?: object, clientText?: string, messages?: object[] }} input
 * @returns {{ category: string, tags: string[], scope: 'small'|'medium'|'large', days: number|null }}
 */
export function extractPriceFeatures({ project = null, analysis = null, clientText = '', messages = null } = {}) {
  const parts = [];
  if (project) parts.push(project.title, project.description, project.categoryTitle, project.category);
  if (Array.isArray(project?.skills)) parts.push(project.skills.map((s) => s?.title || s?.name || s).join(' '));
  if (clientText) parts.push(clientText);
  if (!clientText && Array.isArray(messages)) {
    parts.push(messages.filter((m) => !m.isOwn).map((m) => m.text).join(' '));
  }
  const data = analysis?.data || analysis || {};
  if (Array.isArray(data.requirements)) parts.push(data.requirements.join(' '));
  if (data.summary) parts.push(data.summary);
  const text = ` ${String(parts.filter(Boolean).join(' ')).toLowerCase()} `;

  const tags = Object.entries(TAGS)
    .filter(([, words]) => words.some((w) => text.includes(w.toLowerCase())))
    .map(([tag]) => tag)
    .sort();

  const rawCat = project?.categoryTitle || project?.category || null;
  const category = rawCat ? String(rawCat).trim().toLowerCase().slice(0, 60) : tags[0] || 'general';

  const reqCount = Array.isArray(data.requirements) ? data.requirements.length : 0;
  const complexity = data.complexity || null;
  let scope = 'medium';
  if (complexity === 'low' || (reqCount && reqCount <= 2)) scope = 'small';
  if (complexity === 'high' || reqCount >= 7) scope = 'large';

  const d = Number(data.estimated_days ?? project?.days ?? project?.deadline);
  const days = Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  return { category, tags, scope, days };
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS price_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT,
    project_id TEXT,
    amount_toman INTEGER NOT NULL,
    source TEXT NOT NULL,
    category TEXT,
    tags_json TEXT,
    scope TEXT,
    days INTEGER,
    created_at TEXT NOT NULL
  )`);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ amount: number, source: 'owner_answer'|'owner_approved'|'sent', features: object, roomId?: string, projectId?: string }} s
 * @returns {{ ok: boolean, reason?: string }}
 */
export function recordPriceSample(db, { amount, source, features, roomId = null, projectId = null }) {
  const n = Math.round(Number(amount));
  if (!db || !Number.isFinite(n) || n < MIN_AMOUNT || n > MAX_AMOUNT) return { ok: false, reason: 'invalid_amount' };
  ensureTable(db);
  if (roomId != null) {
    const dup = db
      .prepare(`SELECT id FROM price_samples WHERE room_id = ? AND amount_toman = ? LIMIT 1`)
      .get(String(roomId), n);
    if (dup) return { ok: false, reason: 'duplicate' };
  }
  const f = features || {};
  db.prepare(
    `INSERT INTO price_samples (room_id, project_id, amount_toman, source, category, tags_json, scope, days, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    roomId != null ? String(roomId) : null,
    projectId != null ? String(projectId) : null,
    n,
    String(source || 'sent'),
    f.category || 'general',
    JSON.stringify(f.tags || []),
    f.scope || 'medium',
    f.days ?? null,
    new Date().toISOString()
  );
  return { ok: true };
}

export function similarity(a, b) {
  const ta = new Set(a.tags || []);
  const tb = new Set(b.tags || []);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  let s = union ? inter / union : 0;
  if (a.category && a.category !== 'general' && a.category === b.category) s += 0.4;
  if (a.scope && a.scope === b.scope) s += 0.1;
  return Math.min(1.5, s);
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @returns {{ count: number, median: number|null, spread: number|null, confident: boolean, amount: number|null }}
 */
export function learnedPriceFor(db, features, { minSamples = LEARN_MIN_SAMPLES, maxSpread = LEARN_MAX_SPREAD } = {}) {
  const empty = { count: 0, median: null, spread: null, confident: false, amount: null };
  if (!db || !features) return empty;
  ensureTable(db);
  const rows = db
    .prepare(`SELECT amount_toman, category, tags_json, scope FROM price_samples ORDER BY id DESC LIMIT 500`)
    .all();
  const amounts = [];
  for (const r of rows) {
    let tags = [];
    try {
      tags = JSON.parse(r.tags_json || '[]');
    } catch {
      tags = [];
    }
    if (similarity(features, { category: r.category, tags, scope: r.scope }) >= SIMILARITY_MIN) {
      amounts.push(Number(r.amount_toman));
    }
  }
  if (!amounts.length) return empty;
  amounts.sort((x, y) => x - y);
  const med = median(amounts);
  const spread = med ? (quantile(amounts, 0.75) - quantile(amounts, 0.25)) / med : null;
  const confident = amounts.length >= minSamples && spread != null && spread <= maxSpread;
  return { count: amounts.length, median: Math.round(med), spread, confident, amount: roundToman(med) };
}

/** Round to a friendly Toman figure (100k steps under 10M, 500k above). */
export function roundToman(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  const step = v >= 10_000_000 ? 500_000 : 100_000;
  return Math.max(step, Math.round(v / step) * step);
}

/**
 * Parse a Toman amount from owner input or a sent message.
 * «۲۵ میلیون»، «2.5 میلیون تومان»، «25,000,000»، «۲۵۰۰۰۰۰۰ تومان»، «۸۰۰ هزار».
 * @returns {number|null}
 */
export function parseTomanAmount(text) {
  const t = toLatinDigits(String(text || '')).replace(/٫/g, '.').replace(/[٬،]/g, ',');
  let best = null;
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(میلیارد|میلیون|هزار)?/g;
  let m;
  while ((m = re.exec(t))) {
    const num = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(num)) continue;
    const mult = m[2] === 'میلیارد' ? 1e9 : m[2] === 'میلیون' ? 1e6 : m[2] === 'هزار' ? 1e3 : 1;
    const v = Math.round(num * mult);
    if (v >= MIN_AMOUNT && v <= MAX_AMOUNT && (best == null || v > best)) best = v;
  }
  return best;
}

/**
 * Amount mentioned as a price in a sent chat message (needs a currency / scale word nearby).
 */
export function extractSentPrice(text) {
  const t = toLatinDigits(String(text || ''));
  if (!/تومان|تومن|میلیون|هزار/.test(t)) return null;
  return parseTomanAmount(t);
}

// —— per-room owner answer / pending ask (kv) ——

const answerKey = (roomId) => `room:${roomId}:price_answer`;
const askKey = (roomId) => `room:${roomId}:price_ask`;
const ANSWER_TTL_MS = 30 * 86_400_000;

function kvRead(db, key) {
  try {
    const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function kvWrite(db, key, value) {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

function kvDelete(db, key) {
  try {
    db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
  } catch {
    /* ignore */
  }
}

export function setRoomPriceAnswer(db, roomId, { amount, source = 'owner_answer' }) {
  kvWrite(db, answerKey(roomId), { amount: Math.round(Number(amount)), source, at: new Date().toISOString() });
  kvDelete(db, askKey(roomId));
}

export function getRoomPriceAnswer(db, roomId) {
  const v = kvRead(db, answerKey(roomId));
  if (!v?.amount) return null;
  if (Date.now() - Date.parse(v.at || 0) > ANSWER_TTL_MS) return null;
  return v;
}

export function setRoomPriceAsk(db, roomId, ask) {
  kvWrite(db, askKey(roomId), { ...ask, at: new Date().toISOString() });
}

export function getRoomPriceAsk(db, roomId) {
  return kvRead(db, askKey(roomId));
}

export default {
  extractPriceFeatures,
  recordPriceSample,
  learnedPriceFor,
  parseTomanAmount,
  extractSentPrice,
  roundToman,
  setRoomPriceAnswer,
  getRoomPriceAnswer,
  setRoomPriceAsk,
  getRoomPriceAsk,
};
