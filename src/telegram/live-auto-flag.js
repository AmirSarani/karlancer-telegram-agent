/**
 * ALLOW_LIVE_AUTO_BID effective flag: env default + KV override + hot reload.
 * Default remains false until owner enables with confirm. Emergency stop still wins at gate.
 */
import { writeEnvKey } from '../security/persist-access-token.js';

export const LIVE_AUTO_KV_KEY = 'allow_live_auto_bid';
export const LIVE_AUTO_ENV_KEY = 'ALLOW_LIVE_AUTO_BID';

/**
 * @param {import('better-sqlite3').Database|null|undefined} db
 * @param {{ envDefault?: boolean }} [opts]
 * @returns {boolean}
 */
export function readLiveAutoBidFlag(db, { envDefault = false } = {}) {
  if (db) {
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(LIVE_AUTO_KV_KEY);
      if (row?.value != null && String(row.value).trim() !== '') {
        const v = String(row.value).trim().toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes') return true;
        if (v === 'false' || v === '0' || v === 'no') return false;
      }
    } catch {
      /* fall through */
    }
  }
  return Boolean(envDefault);
}

/**
 * Persist flag to KV (+ optional .env) and invoke hot-reload callback.
 * @param {import('better-sqlite3').Database} db
 * @param {boolean} enabled
 * @param {{ envFile?: string|null, onChange?: (v: boolean) => void, syncEnv?: boolean }} [opts]
 */
export function writeLiveAutoBidFlag(db, enabled, { envFile = null, onChange = null, syncEnv = true } = {}) {
  const value = enabled === true;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(LIVE_AUTO_KV_KEY, value ? 'true' : 'false', now);

  process.env[LIVE_AUTO_ENV_KEY] = value ? 'true' : 'false';

  let envOk = null;
  if (syncEnv && envFile) {
    try {
      writeEnvKey(envFile, LIVE_AUTO_ENV_KEY, value ? 'true' : 'false');
      envOk = true;
    } catch {
      envOk = false;
    }
  }

  if (typeof onChange === 'function') {
    try {
      onChange(value);
    } catch {
      /* ignore */
    }
  }

  return { ok: true, enabled: value, envOk, updatedAt: now };
}

/**
 * Mutable ref for in-process hot reload (bot + worker share same process in main).
 * @param {boolean} initial
 */
export function createLiveAutoBidRef(initial = false) {
  let value = Boolean(initial);
  return {
    get: () => value,
    set: (v) => {
      value = Boolean(v);
      return value;
    },
  };
}

export default { readLiveAutoBidFlag, writeLiveAutoBidFlag, createLiveAutoBidRef };


/** Live auto-send for chat replies (separate from bid). Default false. */
export const LIVE_AUTO_SEND_KV_KEY = 'allow_live_auto_send';
export const LIVE_AUTO_SEND_ENV_KEY = 'ALLOW_LIVE_AUTO_SEND';

/**
 * @param {import('better-sqlite3').Database|null|undefined} db
 * @param {{ envDefault?: boolean }} [opts]
 */
export function readLiveAutoSendFlag(db, { envDefault = false } = {}) {
  if (db) {
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(LIVE_AUTO_SEND_KV_KEY);
      if (row?.value != null && String(row.value).trim() !== '') {
        const v = String(row.value).trim().toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes') return true;
        if (v === 'false' || v === '0' || v === 'no') return false;
      }
    } catch {
      /* fall through */
    }
  }
  return Boolean(envDefault);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {boolean} enabled
 * @param {{ envFile?: string|null, onChange?: (v: boolean) => void, syncEnv?: boolean }} [opts]
 */
export function writeLiveAutoSendFlag(db, enabled, { envFile = null, onChange = null, syncEnv = true } = {}) {
  const value = enabled === true;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(LIVE_AUTO_SEND_KV_KEY, value ? 'true' : 'false', now);

  process.env[LIVE_AUTO_SEND_ENV_KEY] = value ? 'true' : 'false';

  let envOk = null;
  if (syncEnv && envFile) {
    try {
      writeEnvKey(envFile, LIVE_AUTO_SEND_ENV_KEY, value ? 'true' : 'false');
      envOk = true;
    } catch {
      envOk = false;
    }
  }

  if (typeof onChange === 'function') {
    try {
      onChange(value);
    } catch {
      /* ignore */
    }
  }

  return { ok: true, enabled: value, envOk, updatedAt: now };
}

export function createLiveAutoSendRef(initial = false) {
  let value = Boolean(initial);
  return {
    get: () => value,
    set: (v) => {
      value = Boolean(v);
      return value;
    },
  };
}
