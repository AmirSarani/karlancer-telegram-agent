/**
 * Normalize Karlancer project/invite payloads into ProjectOpportunity.
 * Only uses fields already present on adapters / HAR search results — no guessing.
 */

/**
 * @typedef {object} ProjectOpportunity
 * @property {string} id
 * @property {string|null} title
 * @property {string|null} description
 * @property {number|null} budgetMin
 * @property {number|null} budgetMax
 * @property {string|null} category
 * @property {string[]} skills
 * @property {{ id?: string|null, rate?: number|null, rateNum?: number|null, country?: string|null }|null} client
 * @property {string|null} createdAt
 * @property {string|null} status
 * @property {'search'|'invite'} source
 * @property {string|null} slug
 * @property {boolean|null} isUrgent
 * @property {boolean|null} isExpired
 * @property {string|null} pastTime
 * @property {number|null} ageHours
 */

/**
 * @param {object|null|undefined} input — adapter project or raw HAR item (may include .raw)
 * @param {{ source?: 'search'|'invite', now?: Date }} [opts]
 * @returns {ProjectOpportunity|null}
 */
export function toProjectOpportunity(input, opts = {}) {
  if (!input || typeof input !== 'object') return null;
  const raw = input.raw && typeof input.raw === 'object' ? input.raw : input;
  const id = pickId(input.id ?? raw.id);
  if (!id) return null;

  const skills = extractSkills(input.skills ?? raw.skills);
  const budgetMin = toNum(
    input.minBudget ?? input.budgetMin ?? raw.min_budget ?? raw.minBudget ?? null
  );
  const budgetMax = toNum(
    input.maxBudget ?? input.budgetMax ?? raw.max_budget ?? raw.maxBudget ?? null
  );
  const category =
    strOrNull(input.category ?? raw.category) ||
    (raw.category_id != null || input.categoryId != null
      ? String(raw.category_id ?? input.categoryId)
      : null);

  const createdAt = extractCreatedAt(input, raw);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ageHours = createdAt ? hoursBetween(createdAt, now) : null;

  const rate = toNum(raw.rate ?? input.rate);
  const rateNum = toNum(raw.rate_num ?? raw.rateNum ?? input.rateNum);

  return {
    id,
    title: strOrNull(input.title ?? raw.title),
    description: strOrNull(
      input.description ?? raw.description ?? raw.desc ?? raw.body
    ),
    budgetMin,
    budgetMax,
    category,
    skills,
    client: {
      id: pickId(raw.user_id ?? raw.userId ?? input.userId),
      rate: rate,
      rateNum: rateNum,
      country: strOrNull(raw.country ?? input.country),
    },
    createdAt,
    status: strOrNull(input.state ?? input.status ?? raw.state ?? raw.status),
    source: opts.source === 'invite' ? 'invite' : 'search',
    slug: strOrNull(input.slug ?? raw.url ?? raw.slug),
    isUrgent: boolOrNull(input.isUrgent ?? raw.is_urgent ?? raw.isUrgent),
    isExpired: boolOrNull(input.isExpired ?? raw.is_expired ?? raw.isExpired),
    pastTime: strOrNull(raw.past_time ?? raw.pastTime ?? input.pastTime),
    ageHours,
  };
}

function pickId(v) {
  if (v == null || v === '') return null;
  return String(v);
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function toNum(v) {
  if (v == null || v === '' || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v) {
  if (v == null) return null;
  return Boolean(v);
}

function extractSkills(skills) {
  if (!Array.isArray(skills)) return [];
  const out = [];
  for (const s of skills) {
    if (typeof s === 'string' && s.trim()) out.push(s.trim());
    else if (s && typeof s === 'object') {
      const name = s.name || s.title || s.label;
      if (name) out.push(String(name).trim());
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function extractCreatedAt(input, raw) {
  const candidates = [
    input.createdAt,
    raw.created_at,
    raw.createdAt,
    raw.ladder_at,
    raw.ladderAt,
    raw.published_at,
    raw.publishedAt,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(String(c));
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

function hoursBetween(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}

export default toProjectOpportunity;
