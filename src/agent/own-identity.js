/**
 * Own Karlancer user id — resolved via api.user.me() and cached in SQLite kv.
 * Used to tell our own chat messages apart when the API has no is_me flag
 * (HAR messages carry sender_id only). Never stores tokens.
 */
export const OWN_USER_KV_KEY = 'karlancer_own_user_id';
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ api?: object|null, db?: import('better-sqlite3').Database|null, now?: () => number }} deps
 * @returns {Promise<string|null>}
 */
export async function getOwnUserId({ api = null, db = null, now = Date.now } = {}) {
  const cached = readCached(db, now);
  if (cached) return cached;
  if (!api?.user?.me) return readCached(db, now, { ignoreTtl: true });
  try {
    const me = await api.user.me();
    const id = me?.id != null && String(me.id).trim() !== '' ? String(me.id) : null;
    if (id && db) {
      db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(OWN_USER_KV_KEY, JSON.stringify({ id, at: now() }), new Date(now()).toISOString());
    }
    return id || readCached(db, now, { ignoreTtl: true });
  } catch {
    return readCached(db, now, { ignoreTtl: true });
  }
}

function readCached(db, now, { ignoreTtl = false } = {}) {
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(OWN_USER_KV_KEY);
    if (!row?.value) return null;
    const v = JSON.parse(row.value);
    if (!v?.id) return null;
    if (!ignoreTtl && Number(v.at) && now() - Number(v.at) > TTL_MS) return null;
    return String(v.id);
  } catch {
    return null;
  }
}

export default getOwnUserId;
