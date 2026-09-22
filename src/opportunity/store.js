/**
 * SQLite persistence for opportunities, data-driven rules, decisions, scan cursor.
 */
import crypto from 'node:crypto';

export const OPP_STATES = Object.freeze([
  'NEW',
  'ANALYZED',
  'MATCHED',
  'IGNORED',
  'ACTION_CREATED',
  'SUBMITTED',
]);

export const OPP_ACTIONS = Object.freeze([
  'CREATE_BID_DRAFT',
  'NOTIFY',
  'IGNORE',
  'REQUEST_APPROVAL',
  'AUTO_EXECUTE',
]);

export const DECISIONS = Object.freeze([
  'IGNORE',
  'NOTIFY',
  'CREATE_DRAFT',
  'REQUEST_APPROVAL',
  'AUTO_EXECUTE',
]);

const SCORING_PROFILE_KEY = 'opportunity_scoring_profile';
const SCAN_STATE_KEY_PREFIX = 'opportunity_scan_state';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function ensureOpportunitySchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS opportunity_projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source TEXT NOT NULL DEFAULT 'search',
  title TEXT,
  description TEXT,
  budget_min REAL,
  budget_max REAL,
  category TEXT,
  skills_json TEXT,
  client_json TEXT,
  created_at_src TEXT,
  status TEXT,
  state TEXT NOT NULL DEFAULT 'NEW',
  score INTEGER,
  score_reasons_json TEXT,
  matched_rules_json TEXT,
  decision TEXT,
  decision_detail_json TEXT,
  payload_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_state ON opportunity_projects(tenant_id, state, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_opp_score ON opportunity_projects(tenant_id, score);

CREATE TABLE IF NOT EXISTS opportunity_rules (
  rule_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  conditions_json TEXT NOT NULL,
  action TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_rules_en ON opportunity_rules(tenant_id, enabled, priority);

CREATE TABLE IF NOT EXISTS opportunity_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  project_id TEXT NOT NULL,
  score INTEGER,
  matched_rules_json TEXT,
  decision TEXT NOT NULL,
  reasons_json TEXT,
  mode TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_dec_proj ON opportunity_decisions(tenant_id, project_id, created_at);
`);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ tenantId?: string }} [opts]
 */
export function createOpportunityStore(db, { tenantId = 'default' } = {}) {
  ensureOpportunitySchema(db);

  function upsertOpportunity(opp, { state = 'NEW' } = {}) {
    const now = new Date().toISOString();
    const existing = db
      .prepare(
        `SELECT id, state, first_seen_at FROM opportunity_projects WHERE id = ? AND tenant_id = ?`
      )
      .get(opp.id, tenantId);
    const payload = JSON.stringify(opp);
    const skillsJson = JSON.stringify(opp.skills || []);
    const clientJson = JSON.stringify(opp.client || null);
    if (existing) {
      db.prepare(
        `UPDATE opportunity_projects SET
          source = ?, title = ?, description = ?, budget_min = ?, budget_max = ?,
          category = ?, skills_json = ?, client_json = ?, created_at_src = ?,
          status = ?, payload_json = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).run(
        opp.source || 'search',
        opp.title,
        opp.description,
        opp.budgetMin,
        opp.budgetMax,
        opp.category,
        skillsJson,
        clientJson,
        opp.createdAt,
        opp.status,
        payload,
        now,
        now,
        opp.id,
        tenantId
      );
      return {
        id: opp.id,
        isNew: false,
        state: existing.state,
        firstSeenAt: existing.first_seen_at,
      };
    }
    db.prepare(
      `INSERT INTO opportunity_projects (
        id, tenant_id, source, title, description, budget_min, budget_max,
        category, skills_json, client_json, created_at_src, status, state,
        payload_json, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      opp.id,
      tenantId,
      opp.source || 'search',
      opp.title,
      opp.description,
      opp.budgetMin,
      opp.budgetMax,
      opp.category,
      skillsJson,
      clientJson,
      opp.createdAt,
      opp.status,
      state,
      payload,
      now,
      now,
      now
    );
    return { id: opp.id, isNew: true, state, firstSeenAt: now };
  }

  function updateAnalysis(projectId, patch) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE opportunity_projects SET
        score = ?, score_reasons_json = ?, matched_rules_json = ?,
        decision = ?, decision_detail_json = ?, state = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(
      patch.score ?? null,
      patch.reasons ? JSON.stringify(patch.reasons) : null,
      patch.matchedRules ? JSON.stringify(patch.matchedRules) : null,
      patch.decision ?? null,
      patch.decisionDetail ? JSON.stringify(patch.decisionDetail) : null,
      patch.state || 'ANALYZED',
      now,
      projectId,
      tenantId
    );
  }

  function setState(projectId, state) {
    if (!OPP_STATES.includes(state)) throw new Error('invalid_opp_state');
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE opportunity_projects SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
    ).run(state, now, projectId, tenantId);
  }

  function get(projectId) {
    const row = db
      .prepare(`SELECT * FROM opportunity_projects WHERE id = ? AND tenant_id = ?`)
      .get(projectId, tenantId);
    return row ? mapOppRow(row) : null;
  }

  function list({ state = null, minScore = null, limit = 20, offset = 0 } = {}) {
    let sql = `SELECT * FROM opportunity_projects WHERE tenant_id = ?`;
    const params = [tenantId];
    if (state) {
      sql += ` AND state = ?`;
      params.push(state);
    }
    if (minScore != null) {
      sql += ` AND score >= ?`;
      params.push(Number(minScore));
    }
    sql += ` ORDER BY COALESCE(score, 0) DESC, last_seen_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(100, Math.max(1, limit)), Math.max(0, offset));
    return db.prepare(sql).all(...params).map(mapOppRow);
  }

  function hasSubmittedOrAction(projectId) {
    const row = db
      .prepare(`SELECT state FROM opportunity_projects WHERE id = ? AND tenant_id = ?`)
      .get(projectId, tenantId);
    return Boolean(row && (row.state === 'SUBMITTED' || row.state === 'ACTION_CREATED'));
  }

  function createRule({ name, conditions, action, priority = 100, enabled = true, meta = {} }) {
    if (!name) throw new Error('rule_name_required');
    if (!OPP_ACTIONS.includes(action)) throw new Error('invalid_rule_action');
    if (!Array.isArray(conditions)) throw new Error('conditions_must_be_array');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO opportunity_rules (
        rule_id, tenant_id, name, enabled, priority, conditions_json, action, meta_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      tenantId,
      String(name),
      enabled ? 1 : 0,
      Number(priority) || 100,
      JSON.stringify(conditions),
      action,
      JSON.stringify(meta || {}),
      now,
      now
    );
    return getRule(id);
  }

  function updateRule(ruleId, patch = {}) {
    const cur = getRule(ruleId);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      enabled: patch.enabled != null ? Boolean(patch.enabled) : cur.enabled,
      priority: patch.priority != null ? Number(patch.priority) : cur.priority,
      conditions: patch.conditions ?? cur.conditions,
      action: patch.action ?? cur.action,
      meta: patch.meta ?? cur.meta,
    };
    if (patch.action && !OPP_ACTIONS.includes(patch.action)) throw new Error('invalid_rule_action');
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE opportunity_rules SET
        name = ?, enabled = ?, priority = ?, conditions_json = ?, action = ?, meta_json = ?, updated_at = ?
       WHERE rule_id = ? AND tenant_id = ?`
    ).run(
      next.name,
      next.enabled ? 1 : 0,
      next.priority,
      JSON.stringify(next.conditions),
      next.action,
      JSON.stringify(next.meta || {}),
      now,
      ruleId,
      tenantId
    );
    return getRule(ruleId);
  }

  function setRuleEnabled(ruleId, enabled) {
    return updateRule(ruleId, { enabled: Boolean(enabled) });
  }

  function deleteRule(ruleId) {
    const r = db
      .prepare(`DELETE FROM opportunity_rules WHERE rule_id = ? AND tenant_id = ?`)
      .run(ruleId, tenantId);
    return r.changes > 0;
  }

  function getRule(ruleId) {
    const row = db
      .prepare(`SELECT * FROM opportunity_rules WHERE rule_id = ? AND tenant_id = ?`)
      .get(ruleId, tenantId);
    return row ? mapRuleRow(row) : null;
  }

  function listRules({ enabledOnly = false } = {}) {
    let sql = `SELECT * FROM opportunity_rules WHERE tenant_id = ?`;
    const params = [tenantId];
    if (enabledOnly) sql += ` AND enabled = 1`;
    sql += ` ORDER BY priority ASC, created_at ASC`;
    return db.prepare(sql).all(...params).map(mapRuleRow);
  }

  function recordDecision({
    projectId,
    score,
    matchedRules,
    decision,
    reasons,
    mode,
    detail,
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO opportunity_decisions (
        id, tenant_id, project_id, score, matched_rules_json, decision, reasons_json, mode, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      tenantId,
      String(projectId),
      score ?? null,
      JSON.stringify(matchedRules || []),
      decision,
      JSON.stringify(reasons || []),
      mode || null,
      JSON.stringify(detail || {}),
      now
    );
    try {
      db.prepare(
        `INSERT INTO audit_log (
          id, tenant_id, actor, action, tool, input_hash, result_code, correlation_id, created_at, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        tenantId,
        'opportunity_engine',
        `opportunity.${decision}`,
        'opportunity_decision',
        null,
        decision,
        String(projectId),
        now,
        JSON.stringify({
          projectId,
          score,
          matchedRules,
          decision,
          reasons,
          mode,
          ...detail,
          time: now,
        })
      );
    } catch {
      /* optional if audit schema differs */
    }
    return { id, createdAt: now };
  }

  function listDecisions({ projectId = null, limit = 20 } = {}) {
    let sql = `SELECT * FROM opportunity_decisions WHERE tenant_id = ?`;
    const params = [tenantId];
    if (projectId) {
      sql += ` AND project_id = ?`;
      params.push(String(projectId));
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(Math.min(100, Math.max(1, limit)));
    return db.prepare(sql).all(...params).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      score: r.score,
      matchedRules: safeJson(r.matched_rules_json, []),
      decision: r.decision,
      reasons: safeJson(r.reasons_json, []),
      mode: r.mode,
      detail: safeJson(r.detail_json, {}),
      createdAt: r.created_at,
    }));
  }

  function getScoringProfile() {
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(SCORING_PROFILE_KEY);
      if (!row?.value) return defaultScoringProfile();
      return { ...defaultScoringProfile(), ...JSON.parse(row.value) };
    } catch {
      return defaultScoringProfile();
    }
  }

  function setScoringProfile(profile) {
    const next = { ...defaultScoringProfile(), ...profile, updatedAt: new Date().toISOString() };
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(SCORING_PROFILE_KEY, JSON.stringify(next), next.updatedAt);
    return next;
  }

  function getScanState() {
    const key = `${SCAN_STATE_KEY_PREFIX}:${tenantId}`;
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
      if (!row?.value) {
        return {
          lastScanAt: null,
          lastProjectIds: [],
          cooldownUntil: null,
          intervalMs: 30 * 60_000,
          paused: false,
        };
      }
      return JSON.parse(row.value);
    } catch {
      return {
        lastScanAt: null,
        lastProjectIds: [],
        cooldownUntil: null,
        intervalMs: 30 * 60_000,
        paused: false,
      };
    }
  }

  function setScanState(patch) {
    const key = `${SCAN_STATE_KEY_PREFIX}:${tenantId}`;
    const cur = getScanState();
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(next), next.updatedAt);
    return next;
  }

  return {
    tenantId,
    upsertOpportunity,
    updateAnalysis,
    setState,
    get,
    list,
    listOpportunities: (opts) => list(opts),
    getOpportunity: (id) => get(id),
    hasSubmittedOrAction,
    createRule,
    updateRule,
    setRuleEnabled,
    deleteRule,
    getRule,
    listRules,
    recordDecision,
    listDecisions,
    getScoringProfile,
    setScoringProfile,
    getScanState,
    setScanState,
  };
}

export function defaultScoringProfile() {
  return {
    preferredSkills: [],
    preferredCategories: [],
    budgetMin: null,
    budgetMax: null,
    freshHours: 24,
    clientMinRate: 4,
    weights: {
      skills: 30,
      budget: 20,
      category: 20,
      fresh: 15,
      client: 15,
    },
    updatedAt: null,
  };
}

function mapOppRow(r) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    source: r.source,
    title: r.title,
    description: r.description,
    budgetMin: r.budget_min,
    budgetMax: r.budget_max,
    category: r.category,
    skills: safeJson(r.skills_json, []),
    client: safeJson(r.client_json, null),
    createdAt: r.created_at_src,
    status: r.status,
    state: r.state,
    score: r.score,
    scoreReasons: safeJson(r.score_reasons_json, []),
    matchedRules: safeJson(r.matched_rules_json, []),
    decision: r.decision,
    decisionDetail: safeJson(r.decision_detail_json, null),
    opportunity: safeJson(r.payload_json, null),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    updatedAt: r.updated_at,
  };
}

function mapRuleRow(r) {
  return {
    ruleId: r.rule_id,
    tenantId: r.tenant_id,
    name: r.name,
    enabled: Boolean(r.enabled),
    priority: r.priority,
    conditions: safeJson(r.conditions_json, []),
    action: r.action,
    meta: safeJson(r.meta_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export default createOpportunityStore;
