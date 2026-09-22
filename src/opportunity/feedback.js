/**
 * Light feedback learning — ignore/reject adjusts score bias or rule soft-penalty in kv.
 * Explainable, no ML. Bias applied as additive score adjustment + reason string.
 */
const FEEDBACK_KV_KEY = 'opportunity_feedback_bias';

/**
 * @returns {{
 *   skillPenalties: Record<string, number>,
 *   categoryPenalties: Record<string, number>,
 *   globalBias: number,
 *   ignoredCount: number,
 *   rejectedCount: number,
 *   updatedAt: string|null,
 * }}
 */
export function defaultFeedbackState() {
  return {
    skillPenalties: {},
    categoryPenalties: {},
    globalBias: 0,
    ignoredCount: 0,
    rejectedCount: 0,
    updatedAt: null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ tenantId?: string }} [opts]
 */
export function createFeedbackStore(db, { tenantId = 'default' } = {}) {
  const key = tenantId === 'default' ? FEEDBACK_KV_KEY : `${FEEDBACK_KV_KEY}:${tenantId}`;

  function read() {
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
      if (!row?.value) return defaultFeedbackState();
      return { ...defaultFeedbackState(), ...JSON.parse(row.value) };
    } catch {
      return defaultFeedbackState();
    }
  }

  function write(next) {
    const normalized = {
      ...defaultFeedbackState(),
      ...next,
      skillPenalties: { ...(next.skillPenalties || {}) },
      categoryPenalties: { ...(next.categoryPenalties || {}) },
      updatedAt: new Date().toISOString(),
    };
    // Cap maps
    normalized.skillPenalties = capMap(normalized.skillPenalties, 40);
    normalized.categoryPenalties = capMap(normalized.categoryPenalties, 20);
    normalized.globalBias = clamp(normalized.globalBias, -15, 5);
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(normalized), normalized.updatedAt);
    return normalized;
  }

  /**
   * Record owner ignore/reject on an opportunity.
   * @param {'ignore'|'reject'} kind
   * @param {object} opportunity
   */
  function record(kind, opportunity) {
    const cur = read();
    const skills = toList(opportunity?.skills);
    const category =
      opportunity?.category != null ? String(opportunity.category).trim().toLowerCase() : '';
    const delta = kind === 'reject' ? -3 : -2;
    if (kind === 'ignore') cur.ignoredCount = (cur.ignoredCount || 0) + 1;
    if (kind === 'reject') cur.rejectedCount = (cur.rejectedCount || 0) + 1;
    cur.globalBias = clamp((cur.globalBias || 0) + (kind === 'reject' ? -1 : -0.5), -15, 5);
    for (const sk of skills.slice(0, 5)) {
      cur.skillPenalties[sk] = clamp((cur.skillPenalties[sk] || 0) + delta, -20, 0);
    }
    if (category) {
      cur.categoryPenalties[category] = clamp(
        (cur.categoryPenalties[category] || 0) + delta,
        -15,
        0
      );
    }
    return write(cur);
  }

  /**
   * Soft-penalty for a rule id when owner ignores after that rule matched.
   * Stored inside skillPenalties map under `rule:<id>` key for simplicity.
   */
  function softPenaltyRule(ruleId, amount = -2) {
    const cur = read();
    const k = `rule:${String(ruleId)}`;
    cur.skillPenalties[k] = clamp((cur.skillPenalties[k] || 0) + amount, -20, 0);
    return write(cur);
  }

  /**
   * Apply bias to a scored opportunity.
   * @param {{ score: number, reasons: string[], breakdown?: object }} scored
   * @param {object} opportunity
   * @param {object[]} [matchedRules]
   */
  function applyBias(scored, opportunity, matchedRules = []) {
    const state = read();
    let adj = Number(state.globalBias) || 0;
    /** @type {string[]} */
    const extra = [];
    const skills = toList(opportunity?.skills);
    for (const sk of skills) {
      const p = state.skillPenalties[sk];
      if (p) {
        adj += p;
        extra.push(`بازخورد: مهارت «${sk}» جریمه نرم (${p})`);
      }
    }
    const cat =
      opportunity?.category != null ? String(opportunity.category).trim().toLowerCase() : '';
    if (cat && state.categoryPenalties[cat]) {
      const p = state.categoryPenalties[cat];
      adj += p;
      extra.push(`بازخورد: دسته «${cat}» جریمه نرم (${p})`);
    }
    for (const r of matchedRules || []) {
      const id = r.ruleId || r.id;
      if (!id) continue;
      const p = state.skillPenalties[`rule:${id}`];
      if (p) {
        adj += p;
        extra.push(`بازخورد: قانون «${r.name || id}» جریمه نرم (${p})`);
      }
    }
    adj = clamp(Math.round(adj), -25, 10);
    const score = Math.max(0, Math.min(100, Math.round((scored.score || 0) + adj)));
    const reasons = [...(scored.reasons || [])];
    if (adj !== 0) {
      reasons.push(`تنظیم بازخورد مالک: ${adj > 0 ? '+' : ''}${adj}`);
      reasons.push(...extra.slice(0, 4));
    }
    return {
      score,
      reasons,
      breakdown: { ...(scored.breakdown || {}), feedback: adj },
      feedbackAdj: adj,
    };
  }

  return { read, write, record, softPenaltyRule, applyBias, key };
}

function toList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(lo, Math.min(hi, x));
}

function capMap(obj, maxKeys) {
  const entries = Object.entries(obj || {}).sort((a, b) => a[1] - b[1]);
  const sliced = entries.slice(0, maxKeys);
  return Object.fromEntries(sliced);
}

export default createFeedbackStore;
