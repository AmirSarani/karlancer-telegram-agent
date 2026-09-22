/**
 * Data-driven rule engine — conditions evaluated against ProjectOpportunity.
 * No hardcoded business policies; rules live in SQLite via opportunity store.
 */

/**
 * @typedef {object} RuleCondition
 * @property {string} field — title|description|skills|category|budgetMin|budgetMax|budget|ageHours|status|client.rate|source
 * @property {string} op — contains|not_contains|eq|neq|gt|gte|lt|lte|between|in|has_any|has_all|exists
 * @property {*} value
 * @property {*} [valueTo] — for between
 */

/**
 * Evaluate all enabled rules (already sorted by priority ASC).
 * @param {object} opportunity — ProjectOpportunity
 * @param {object[]} rules
 * @returns {{ matched: object[], primary: object|null }}
 */
export function matchRules(opportunity, rules) {
  const matched = [];
  for (const rule of rules || []) {
    if (!rule?.enabled) continue;
    if (evaluateConditions(opportunity, rule.conditions || [])) {
      matched.push({
        ruleId: rule.ruleId,
        name: rule.name,
        action: rule.action,
        priority: rule.priority,
        meta: rule.meta || {},
      });
    }
  }
  return { matched, primary: matched[0] || null };
}

/**
 * All conditions must pass (AND). Empty conditions → never match (force explicit config).
 * @param {object} opportunity
 * @param {RuleCondition[]} conditions
 */
export function evaluateConditions(opportunity, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  return conditions.every((c) => evaluateOne(opportunity, c));
}

/**
 * @param {object} opportunity
 * @param {RuleCondition} cond
 */
export function evaluateOne(opportunity, cond) {
  if (!cond || typeof cond !== 'object') return false;
  const field = String(cond.field || '');
  const op = String(cond.op || '').toLowerCase();
  const actual = resolveField(opportunity, field);
  const expected = cond.value;
  const expectedTo = cond.valueTo;

  switch (op) {
    case 'exists':
      return actual != null && actual !== '' && !(Array.isArray(actual) && actual.length === 0);
    case 'eq':
      return normalizeComparable(actual) === normalizeComparable(expected);
    case 'neq':
      return normalizeComparable(actual) !== normalizeComparable(expected);
    case 'contains':
      return contains(actual, expected);
    case 'not_contains':
      return !contains(actual, expected);
    case 'gt':
      return toNumber(actual) != null && toNumber(actual) > Number(expected);
    case 'gte':
      return toNumber(actual) != null && toNumber(actual) >= Number(expected);
    case 'lt':
      return toNumber(actual) != null && toNumber(actual) < Number(expected);
    case 'lte':
      return toNumber(actual) != null && toNumber(actual) <= Number(expected);
    case 'between': {
      const n = toNumber(actual);
      if (n == null) return false;
      const lo = Number(expected);
      const hi = Number(expectedTo ?? cond.valueHi);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
    }
    case 'in': {
      const list = Array.isArray(expected) ? expected : [expected];
      const norm = normalizeComparable(actual);
      return list.map(normalizeComparable).includes(norm);
    }
    case 'has_any': {
      const want = toStringList(expected);
      const have = toStringList(actual);
      if (!want.length) return false;
      return want.some((w) => have.some((h) => h.includes(w) || w.includes(h)));
    }
    case 'has_all': {
      const want = toStringList(expected);
      const have = toStringList(actual);
      if (!want.length) return false;
      return want.every((w) => have.some((h) => h.includes(w) || w.includes(h)));
    }
    default:
      return false;
  }
}

function resolveField(opp, field) {
  if (!opp) return null;
  switch (field) {
    case 'title':
      return opp.title;
    case 'description':
      return opp.description;
    case 'skills':
      return opp.skills || [];
    case 'category':
      return opp.category;
    case 'budgetMin':
      return opp.budgetMin;
    case 'budgetMax':
      return opp.budgetMax;
    case 'budget':
      // Prefer mid-point when both present
      if (opp.budgetMin != null && opp.budgetMax != null) {
        return (Number(opp.budgetMin) + Number(opp.budgetMax)) / 2;
      }
      return opp.budgetMax ?? opp.budgetMin ?? null;
    case 'ageHours':
      return opp.ageHours;
    case 'status':
      return opp.status;
    case 'source':
      return opp.source;
    case 'client.rate':
    case 'clientRate':
      return opp.client?.rate ?? opp.client?.rateNum ?? null;
    case 'client.id':
      return opp.client?.id ?? null;
    case 'isUrgent':
      return opp.isUrgent;
    case 'isExpired':
      return opp.isExpired;
    default:
      return null;
  }
}

function contains(actual, expected) {
  const needle = String(expected ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return false;
  if (Array.isArray(actual)) {
    return actual.some((x) => String(x).toLowerCase().includes(needle));
  }
  return String(actual ?? '')
    .toLowerCase()
    .includes(needle);
}

function toStringList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (v == null || v === '') return [];
  return [String(v).trim().toLowerCase()];
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeComparable(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  return String(v).trim().toLowerCase();
}

/**
 * Map rule action → decision engine action token.
 * @param {string} ruleAction
 */
export function ruleActionToDecision(ruleAction) {
  switch (ruleAction) {
    case 'CREATE_BID_DRAFT':
      return 'CREATE_DRAFT';
    case 'NOTIFY':
      return 'NOTIFY';
    case 'IGNORE':
      return 'IGNORE';
    case 'REQUEST_APPROVAL':
      return 'REQUEST_APPROVAL';
    case 'AUTO_EXECUTE':
      return 'AUTO_EXECUTE';
    default:
      return 'NOTIFY';
  }
}

export default { matchRules, evaluateConditions, evaluateOne, ruleActionToDecision };
