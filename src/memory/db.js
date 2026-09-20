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
  result_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority, created_at);

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
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export default openDb;
