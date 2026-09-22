/**
 * Lightweight Telegram wizard / awaiting-input state in SQLite kv.
 * Used for scoring profile + rule editor flows (owner text replies).
 */
const keyFor = (userId) => `tg:wizard:${userId}`;

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createWizardState(db) {
  function get(userId) {
    if (userId == null) return null;
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(keyFor(userId));
      if (!row?.value) return null;
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  function set(userId, state) {
    if (userId == null) return null;
    const next = { ...state, updatedAt: new Date().toISOString() };
    const now = next.updatedAt;
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(keyFor(userId), JSON.stringify(next), now);
    return next;
  }

  function clear(userId) {
    if (userId == null) return;
    try {
      db.prepare(`DELETE FROM kv WHERE key = ?`).run(keyFor(userId));
    } catch {
      /* ignore */
    }
  }

  return { get, set, clear };
}

export default createWizardState;
