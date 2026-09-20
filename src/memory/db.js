/**
 * SQLite persistence — source of truth for jobs, events, approvals, memory.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  requested_by TEXT,
  goal TEXT NOT NULL,
  plan_version TEXT DEFAULT '1',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  worker_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_id TEXT,
  result_ref TEXT,
  error_code TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  payload_json TEXT,
  result_json TEXT,
  next_at TEXT,
  operation_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_next ON jobs(status, next_at);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  payload_hash TEXT,
  plan_version TEXT,
  tenant_id TEXT DEFAULT 'default',
  actor TEXT,
  target_ref TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  ref_id TEXT,
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_items(tenant_id, kind, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  actor TEXT,
  action TEXT NOT NULL,
  tool TEXT,
  input_hash TEXT,
  result_code TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_millis INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_day ON token_usage(tenant_id, day);

CREATE TABLE IF NOT EXISTS token_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  job_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoff_meta (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  capability TEXT NOT NULL,
  cron_hint TEXT,
  interval_ms INTEGER NOT NULL,
  payload_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  session_id TEXT PRIMARY KEY,
  api_key_hash TEXT NOT NULL,
  scopes_json TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intelligence_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  recommendation_id TEXT,
  rules_version TEXT,
  features_json TEXT,
  output_json TEXT,
  human_decision TEXT,
  actual_outcome TEXT,
  feedback TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS single_node_lock (
  lock_name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
`;

const MIGRATIONS = [
  `ALTER TABLE audit_log ADD COLUMN tenant_id TEXT DEFAULT 'default'`,
  `ALTER TABLE jobs ADD COLUMN next_at TEXT`,
  `ALTER TABLE jobs ADD COLUMN operation_id TEXT`,
  `ALTER TABLE approvals ADD COLUMN payload_hash TEXT`,
  `ALTER TABLE approvals ADD COLUMN plan_version TEXT`,
  `ALTER TABLE approvals ADD COLUMN tenant_id TEXT DEFAULT 'default'`,
  `ALTER TABLE approvals ADD COLUMN actor TEXT`,
  `ALTER TABLE approvals ADD COLUMN target_ref TEXT`,
  `ALTER TABLE approvals ADD COLUMN expires_at TEXT`,
];

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      /* column may already exist */
    }
  }
  return db;
}

/**
 * Enforce single-node SQLite usage — second process gets conflict.
 */
/**
 * Enforce single-writer SQLite usage.
 * @param {import('better-sqlite3').Database} db
 * @param {string} holder
 * @param {string} [lockName]
 * @param {{ staleMs?: number, heartbeatMs?: number }} [opts]
 *   staleMs default 120_000 — locks older than this may be reclaimed.
 *   If startHeartbeat is used, interval is sooner than staleMs (default staleMs/3).
 */
export function acquireSingleNodeLock(db, holder, lockName = 'sqlite_primary', opts = {}) {
  const staleMs = opts.staleMs ?? 120_000;
  const heartbeatMs = opts.heartbeatMs ?? Math.min(30_000, Math.floor(staleMs / 3));
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT * FROM single_node_lock WHERE lock_name = ?`).get(lockName);
  if (existing && existing.holder !== holder) {
    const hb = Date.parse(existing.heartbeat_at || existing.acquired_at);
    // live lock within staleMs → conflict
    if (Number.isFinite(hb) && Date.now() - hb < staleMs) {
      const err = new Error('single_node_lock_held');
      err.code = 'single_node_lock_held';
      err.holder = existing.holder;
      throw err;
    }
  }
  db.prepare(
    `INSERT INTO single_node_lock (lock_name, holder, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(lock_name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`
  ).run(lockName, holder, now, now);

  let timer = null;
  const lock = {
    staleMs,
    heartbeatMs,
    heartbeat() {
      db.prepare(`UPDATE single_node_lock SET heartbeat_at = ? WHERE lock_name = ? AND holder = ?`).run(
        new Date().toISOString(),
        lockName,
        holder
      );
    },
    /** Start periodic heartbeat (sooner than stale timeout). Idempotent. */
    startHeartbeat() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          lock.heartbeat();
        } catch {
          /* ignore */
        }
      }, heartbeatMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    release() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      db.prepare(`DELETE FROM single_node_lock WHERE lock_name = ? AND holder = ?`).run(lockName, holder);
    },
  };
  return lock;
}

export default openDb;
