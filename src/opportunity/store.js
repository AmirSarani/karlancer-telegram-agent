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
  'WON',
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

export const BOOK_ACTION_TYPES = Object.freeze([
  'notify',
  'draft_prepared',
  'sent_to_approvals',
  'skipped',
  'ignored',
  'approved',
  'rejected',
  'analyzed',
  'auto_enqueued',
]);

export const DRAFT_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'stale']);

const SCORING_PROFILE_KEY = 'opportunity_scoring_profile';
const SCAN_STATE_KEY_PREFIX = 'opportunity_scan_state';
const BOOK_HIGH_SCORE_KEY = 'opportunity_book_high_score';
const DEFAULT_HIGH_SCORE = 55;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_OPPS = 500;
const DEFAULT_MAX_ACTIONS = 1000;
const DEFAULT_MAX_SCAN_RUNS = 120;

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

CREATE TABLE IF NOT EXISTS opportunity_scan_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  at TEXT NOT NULL,
  examined INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  drafted INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  approvals INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  project_ids_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_scan_runs_at ON opportunity_scan_runs(tenant_id, at DESC);

CREATE TABLE IF NOT EXISTS opportunity_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  opp_id TEXT,
  scan_run_id TEXT,
  note TEXT,
  preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_opp_actions_at ON opportunity_actions(tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_opp_actions_opp ON opportunity_actions(tenant_id, opp_id, at DESC);

CREATE TABLE IF NOT EXISTS opportunity_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  opp_id TEXT NOT NULL,
  body TEXT NOT NULL,
  suggested_price REAL,
  suggested_days INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opp_drafts_opp ON opportunity_drafts(tenant_id, opp_id);
CREATE INDEX IF NOT EXISTS idx_opp_drafts_status ON opportunity_drafts(tenant_id, status, updated_at DESC);
`);
  // Soft migrations for columns added after first ship
  try {
    db.exec(`ALTER TABLE opportunity_projects ADD COLUMN last_scan_at TEXT`);
  } catch {
    /* already exists */
  }
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
          status = ?, payload_json = ?, last_seen_at = ?, last_scan_at = ?, updated_at = ?
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
        payload_json, first_seen_at, last_seen_at, last_scan_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  function list({
    state = null,
    minScore = null,
    limit = 20,
    offset = 0,
    orderBy = 'score',
    firstSeenAfter = null,
    excludeStates = null,
  } = {}) {
    let sql = `SELECT * FROM opportunity_projects WHERE tenant_id = ?`;
    const params = [tenantId];
    if (state) {
      sql += ` AND state = ?`;
      params.push(state);
    }
    if (Array.isArray(excludeStates) && excludeStates.length) {
      sql += ` AND state NOT IN (${excludeStates.map(() => '?').join(',')})`;
      params.push(...excludeStates);
    }
    if (minScore != null) {
      sql += ` AND score >= ?`;
      params.push(Number(minScore));
    }
    if (firstSeenAfter) {
      sql += ` AND first_seen_at >= ?`;
      params.push(String(firstSeenAfter));
    }
    if (orderBy === 'first_seen') {
      sql += ` ORDER BY first_seen_at DESC`;
    } else if (orderBy === 'last_seen') {
      sql += ` ORDER BY last_seen_at DESC`;
    } else {
      sql += ` ORDER BY COALESCE(score, 0) DESC, last_seen_at DESC`;
    }
    sql += ` LIMIT ? OFFSET ?`;
    params.push(Math.min(100, Math.max(1, limit)), Math.max(0, offset));
    return db.prepare(sql).all(...params).map(mapOppRow);
  }

  function countOpportunities({
    state = null,
    minScore = null,
    firstSeenAfter = null,
    excludeStates = null,
  } = {}) {
    let sql = `SELECT COUNT(*) AS c FROM opportunity_projects WHERE tenant_id = ?`;
    const params = [tenantId];
    if (state) {
      sql += ` AND state = ?`;
      params.push(state);
    }
    if (Array.isArray(excludeStates) && excludeStates.length) {
      sql += ` AND state NOT IN (${excludeStates.map(() => '?').join(',')})`;
      params.push(...excludeStates);
    }
    if (minScore != null) {
      sql += ` AND score >= ?`;
      params.push(Number(minScore));
    }
    if (firstSeenAfter) {
      sql += ` AND first_seen_at >= ?`;
      params.push(String(firstSeenAfter));
    }
    return Number(db.prepare(sql).get(...params)?.c || 0);
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
          sinceLastId: null,
          cooldownUntil: null,
          intervalMs: 30 * 60_000,
          paused: false,
        };
      }
      const parsed = JSON.parse(row.value);
      return { sinceLastId: null, ...parsed };
    } catch {
      return {
        lastScanAt: null,
        lastProjectIds: [],
        sinceLastId: null,
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


  function getHighScoreThreshold() {
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(BOOK_HIGH_SCORE_KEY);
      if (row?.value != null && row.value !== '') {
        const n = Number(row.value);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_HIGH_SCORE;
  }

  function setHighScoreThreshold(n) {
    const v = Math.min(100, Math.max(0, Number(n) || DEFAULT_HIGH_SCORE));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(BOOK_HIGH_SCORE_KEY, String(v), now);
    return v;
  }

  function recordScanRun(summary = {}) {
    const id = crypto.randomUUID();
    const now = summary.at || summary.scannedAt || new Date().toISOString();
    const projectIds = Array.isArray(summary.projectIds)
      ? summary.projectIds.map(String)
      : (summary.decisions || []).map((d) => String(d?.opportunity?.id || d?.id || '')).filter(Boolean);
    db.prepare(
      `INSERT INTO opportunity_scan_runs (
        id, tenant_id, at, examined, new_count, matched, drafted, notified,
        approvals, ignored, skipped, summary_json, project_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      tenantId,
      now,
      Number(summary.examined ?? summary.scanned ?? 0) || 0,
      Number(summary.newCount ?? 0) || 0,
      Number(summary.matched ?? 0) || 0,
      Number(summary.drafted ?? summary.drafts ?? 0) || 0,
      Number(summary.notified ?? 0) || 0,
      Number(summary.approvals ?? 0) || 0,
      Number(summary.ignored ?? 0) || 0,
      summary.skipped ? 1 : 0,
      JSON.stringify({
        reason: summary.reason || null,
        skipped: Boolean(summary.skipped),
        errors: summary.errors || [],
        autoExecuted: summary.autoExecuted || 0,
        autoMock: summary.autoMock || 0,
      }),
      JSON.stringify(projectIds),
      now
    );
    return { id, at: now, projectIds };
  }

  function listScanRuns({ limit = 20, offset = 0 } = {}) {
    const rows = db
      .prepare(
        `SELECT * FROM opportunity_scan_runs WHERE tenant_id = ?
         ORDER BY at DESC LIMIT ? OFFSET ?`
      )
      .all(tenantId, Math.min(100, Math.max(1, limit)), Math.max(0, offset));
    return rows.map(mapScanRunRow);
  }

  function countScanRuns() {
    return Number(
      db.prepare(`SELECT COUNT(*) AS c FROM opportunity_scan_runs WHERE tenant_id = ?`).get(tenantId)?.c || 0
    );
  }

  function getScanRun(id) {
    const row = db
      .prepare(`SELECT * FROM opportunity_scan_runs WHERE id = ? AND tenant_id = ?`)
      .get(String(id), tenantId);
    return row ? mapScanRunRow(row) : null;
  }

  function listOpportunitiesForScanRun(scanRunId, { limit = 20, offset = 0 } = {}) {
    const run = getScanRun(scanRunId);
    if (!run) return [];
    const ids = run.projectIds || [];
    if (!ids.length) return [];
    const slice = ids.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(50, Math.max(1, limit)));
    const out = [];
    for (const id of slice) {
      const row = get(id);
      if (row) out.push(row);
    }
    return out;
  }

  function recordAction({ type, oppId = null, scanRunId = null, note = null, preview = null, at = null }) {
    const id = crypto.randomUUID();
    const when = at || new Date().toISOString();
    const previewText =
      preview != null ? String(preview).slice(0, 800) : null;
    db.prepare(
      `INSERT INTO opportunity_actions (
        id, tenant_id, type, at, opp_id, scan_run_id, note, preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      tenantId,
      String(type || 'analyzed'),
      when,
      oppId != null ? String(oppId) : null,
      scanRunId != null ? String(scanRunId) : null,
      note != null ? String(note).slice(0, 400) : null,
      previewText
    );
    return { id, at: when, type, oppId };
  }

  function listActions({ limit = 20, offset = 0, oppId = null, type = null } = {}) {
    let sql = `SELECT * FROM opportunity_actions WHERE tenant_id = ?`;
    const params = [tenantId];
    if (oppId) {
      sql += ` AND opp_id = ?`;
      params.push(String(oppId));
    }
    if (type) {
      sql += ` AND type = ?`;
      params.push(String(type));
    }
    sql += ` ORDER BY at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(100, Math.max(1, limit)), Math.max(0, offset));
    return db.prepare(sql).all(...params).map(mapActionRow);
  }

  function countActions({ oppId = null, type = null } = {}) {
    let sql = `SELECT COUNT(*) AS c FROM opportunity_actions WHERE tenant_id = ?`;
    const params = [tenantId];
    if (oppId) {
      sql += ` AND opp_id = ?`;
      params.push(String(oppId));
    }
    if (type) {
      sql += ` AND type = ?`;
      params.push(String(type));
    }
    return Number(db.prepare(sql).get(...params)?.c || 0);
  }

  function upsertDraft({
    oppId,
    body,
    suggestedPrice = null,
    suggestedDays = null,
    status = 'pending',
  }) {
    if (!oppId) throw new Error('draft_opp_id_required');
    const now = new Date().toISOString();
    const existing = db
      .prepare(`SELECT id FROM opportunity_drafts WHERE tenant_id = ? AND opp_id = ?`)
      .get(tenantId, String(oppId));
    const st = DRAFT_STATUSES.includes(status) ? status : 'pending';
    const textBody = String(body || '').slice(0, 8000);
    if (existing) {
      db.prepare(
        `UPDATE opportunity_drafts SET
          body = ?, suggested_price = ?, suggested_days = ?, status = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).run(
        textBody,
        suggestedPrice,
        suggestedDays,
        st,
        now,
        existing.id,
        tenantId
      );
      return getDraftByOpp(oppId);
    }
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO opportunity_drafts (
        id, tenant_id, opp_id, body, suggested_price, suggested_days, created_at, updated_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tenantId, String(oppId), textBody, suggestedPrice, suggestedDays, now, now, st);
    return getDraftByOpp(oppId);
  }

  function getDraftByOpp(oppId) {
    const row = db
      .prepare(`SELECT * FROM opportunity_drafts WHERE tenant_id = ? AND opp_id = ?`)
      .get(tenantId, String(oppId));
    return row ? mapDraftRow(row) : null;
  }

  function getDraft(id) {
    const row = db
      .prepare(`SELECT * FROM opportunity_drafts WHERE id = ? AND tenant_id = ?`)
      .get(String(id), tenantId);
    return row ? mapDraftRow(row) : null;
  }

  function setDraftStatus(oppId, status) {
    const st = DRAFT_STATUSES.includes(status) ? status : 'pending';
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE opportunity_drafts SET status = ?, updated_at = ? WHERE tenant_id = ? AND opp_id = ?`
    ).run(st, now, tenantId, String(oppId));
    return getDraftByOpp(oppId);
  }

  function listDrafts({ status = 'pending', limit = 20, offset = 0 } = {}) {
    let sql = `SELECT * FROM opportunity_drafts WHERE tenant_id = ?`;
    const params = [tenantId];
    if (status) {
      sql += ` AND status = ?`;
      params.push(String(status));
    }
    sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(100, Math.max(1, limit)), Math.max(0, offset));
    return db.prepare(sql).all(...params).map(mapDraftRow);
  }

  function countDrafts({ status = 'pending' } = {}) {
    let sql = `SELECT COUNT(*) AS c FROM opportunity_drafts WHERE tenant_id = ?`;
    const params = [tenantId];
    if (status) {
      sql += ` AND status = ?`;
      params.push(String(status));
    }
    return Number(db.prepare(sql).get(...params)?.c || 0);
  }

  function listNewOpportunities({ withinHours = 48, limit = 20, offset = 0 } = {}) {
    const since = new Date(Date.now() - Math.max(1, withinHours) * 3600_000).toISOString();
    return list({
      firstSeenAfter: since,
      orderBy: 'first_seen',
      limit,
      offset,
      excludeStates: ['IGNORED'],
    });
  }

  function countNewOpportunities({ withinHours = 48 } = {}) {
    const since = new Date(Date.now() - Math.max(1, withinHours) * 3600_000).toISOString();
    return countOpportunities({
      firstSeenAfter: since,
      excludeStates: ['IGNORED'],
    });
  }

  function listHighScore({ minScore = null, limit = 20, offset = 0 } = {}) {
    const threshold = minScore != null ? Number(minScore) : getHighScoreThreshold();
    return list({
      minScore: threshold,
      orderBy: 'score',
      limit,
      offset,
      excludeStates: ['IGNORED'],
    });
  }

  function countHighScore({ minScore = null } = {}) {
    const threshold = minScore != null ? Number(minScore) : getHighScoreThreshold();
    return countOpportunities({
      minScore: threshold,
      excludeStates: ['IGNORED'],
    });
  }

  /**
   * Retention: drop old opportunities / scan runs / actions / stale drafts.
   * Defaults: 90 days or max 500 opps, 120 scan runs, 1000 actions.
   */
  function pruneBook({
    retentionDays = DEFAULT_RETENTION_DAYS,
    maxOpps = DEFAULT_MAX_OPPS,
    maxActions = DEFAULT_MAX_ACTIONS,
    maxScanRuns = DEFAULT_MAX_SCAN_RUNS,
  } = {}) {
    const cutoff = new Date(Date.now() - Math.max(7, retentionDays) * 86400_000).toISOString();
    let pruned = { opps: 0, actions: 0, scans: 0, drafts: 0 };

    const oldOpps = db
      .prepare(
        `DELETE FROM opportunity_projects WHERE tenant_id = ? AND last_seen_at < ?
         AND state IN ('IGNORED', 'ANALYZED')`
      )
      .run(tenantId, cutoff);
    pruned.opps += oldOpps.changes || 0;

    const count = countOpportunities();
    if (count > maxOpps) {
      const excess = count - maxOpps;
      const victims = db
        .prepare(
          `SELECT id FROM opportunity_projects WHERE tenant_id = ?
           ORDER BY last_seen_at ASC LIMIT ?`
        )
        .all(tenantId, excess);
      const del = db.prepare(`DELETE FROM opportunity_projects WHERE id = ? AND tenant_id = ?`);
      for (const v of victims) {
        pruned.opps += del.run(v.id, tenantId).changes || 0;
      }
    }

    const oldActs = db
      .prepare(`DELETE FROM opportunity_actions WHERE tenant_id = ? AND at < ?`)
      .run(tenantId, cutoff);
    pruned.actions += oldActs.changes || 0;
    const actCount = countActions();
    if (actCount > maxActions) {
      const excess = actCount - maxActions;
      db.prepare(
        `DELETE FROM opportunity_actions WHERE id IN (
          SELECT id FROM opportunity_actions WHERE tenant_id = ?
          ORDER BY at ASC LIMIT ?
        )`
      ).run(tenantId, excess);
      pruned.actions += excess;
    }

    const oldScans = db
      .prepare(`DELETE FROM opportunity_scan_runs WHERE tenant_id = ? AND at < ?`)
      .run(tenantId, cutoff);
    pruned.scans += oldScans.changes || 0;
    const scanCount = countScanRuns();
    if (scanCount > maxScanRuns) {
      const excess = scanCount - maxScanRuns;
      db.prepare(
        `DELETE FROM opportunity_scan_runs WHERE id IN (
          SELECT id FROM opportunity_scan_runs WHERE tenant_id = ?
          ORDER BY at ASC LIMIT ?
        )`
      ).run(tenantId, excess);
      pruned.scans += excess;
    }

    const staleDrafts = db
      .prepare(
        `UPDATE opportunity_drafts SET status = 'stale', updated_at = ?
         WHERE tenant_id = ? AND status = 'pending' AND updated_at < ?`
      )
      .run(new Date().toISOString(), tenantId, cutoff);
    pruned.drafts += staleDrafts.changes || 0;
    const oldDrafts = db
      .prepare(
        `DELETE FROM opportunity_drafts WHERE tenant_id = ? AND status IN ('stale','rejected') AND updated_at < ?`
      )
      .run(tenantId, cutoff);
    pruned.drafts += oldDrafts.changes || 0;

    return pruned;
  }

  return {
    tenantId,
    upsertOpportunity,
    updateAnalysis,
    setState,
    get,
    list,
    countOpportunities,
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
    getHighScoreThreshold,
    setHighScoreThreshold,
    recordScanRun,
    listScanRuns,
    countScanRuns,
    getScanRun,
    listOpportunitiesForScanRun,
    recordAction,
    listActions,
    countActions,
    upsertDraft,
    getDraft,
    getDraftByOpp,
    setDraftStatus,
    listDrafts,
    countDrafts,
    listNewOpportunities,
    countNewOpportunities,
    listHighScore,
    countHighScore,
    pruneBook,
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
    lastScanAt: r.last_scan_at || null,
    updatedAt: r.updated_at,
  };
}

function mapScanRunRow(r) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    at: r.at,
    examined: r.examined,
    newCount: r.new_count,
    matched: r.matched,
    drafted: r.drafted,
    notified: r.notified,
    approvals: r.approvals,
    ignored: r.ignored,
    skipped: Boolean(r.skipped),
    summary: safeJson(r.summary_json, {}),
    projectIds: safeJson(r.project_ids_json, []),
    createdAt: r.created_at,
  };
}

function mapActionRow(r) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    at: r.at,
    oppId: r.opp_id,
    scanRunId: r.scan_run_id,
    note: r.note,
    preview: r.preview,
  };
}

function mapDraftRow(r) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    oppId: r.opp_id,
    body: r.body,
    suggestedPrice: r.suggested_price,
    suggestedDays: r.suggested_days,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
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
