/**
 * Scan notify dedupe — auto/scheduled scans stay quiet when the actionable
 * fingerprint is unchanged. Manual /scan and pending UI always notify.
 */
export const SCAN_NOTIFY_FP_KV_KEY = 'last_scan_notify_fingerprint';

/**
 * Stable fingerprint of what the owner was told about.
 * Room ids (sorted) + unread + short last-message watermark + page unread.
 * Does NOT include preparedCount (would re-spam after «قبلاً در صف»).
 * @param {object} [summary]
 * @returns {string}
 */
export function buildScanNotifyFingerprint(summary = {}) {
  const rooms = Array.isArray(summary.priorityRooms) ? summary.priorityRooms : [];
  const roomParts = rooms
    .map((r) => {
      const id = String(r.roomId ?? r.id ?? '').trim();
      if (!id) return null;
      const unread = Number(r.unread) || 0;
      const wm = String(r.last_message || r.lastMessage || r.updatedAt || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
      return `${id}:${unread}:${wm}`;
    })
    .filter(Boolean)
    .sort();
  const matched = (Array.isArray(summary.matched) ? summary.matched : [])
    .map((m) => String(m.roomId ?? '').trim())
    .filter(Boolean)
    .sort();
  const unreadOnPage = Number(summary.unreadOnPage) || 0;
  return `v1|u=${unreadOnPage}|r=${roomParts.join(';')}|m=${matched.join(',')}`;
}

/** @param {object} [summary] */
export function isEmptyScanSummary(summary = {}) {
  const rooms = Array.isArray(summary.priorityRooms) ? summary.priorityRooms : [];
  const matched = Array.isArray(summary.matched) ? summary.matched : [];
  const unread = Number(summary.unreadOnPage) || 0;
  return rooms.length === 0 && matched.length === 0 && unread === 0;
}

/**
 * @param {object} [summary]
 * @param {{
 *   lastFingerprint?: string|null,
 *   forceNotify?: boolean,
 *   hasPendingUi?: boolean,
 * }} [opts]
 * @returns {{ notify: boolean, reason: string, fingerprint: string, persist: boolean }}
 */
export function shouldNotifyScanSummary(summary = {}, opts = {}) {
  const fingerprint = buildScanNotifyFingerprint(summary);
  const force =
    Boolean(opts.forceNotify) ||
    Boolean(opts.hasPendingUi) ||
    Boolean(summary.forceNotify) ||
    summary.scanTrigger === 'manual';

  if (force) {
    return { notify: true, reason: 'manual_or_ui', fingerprint, persist: true };
  }

  const last = opts.lastFingerprint != null ? String(opts.lastFingerprint) : null;
  if (last && last === fingerprint) {
    // Same rooms / unread / watermarks — stay quiet unless brand-new prepares this cycle
    if (Number(summary.preparedCount) > 0) {
      return { notify: true, reason: 'new_prepares', fingerprint, persist: true };
    }
    return { notify: false, reason: 'unchanged', fingerprint, persist: false };
  }

  // First auto after boot with nothing actionable: remember fingerprint, stay quiet
  if (!last && isEmptyScanSummary(summary)) {
    return { notify: false, reason: 'empty_bootstrap', fingerprint, persist: true };
  }

  return {
    notify: true,
    reason: last ? 'changed' : 'first',
    fingerprint,
    persist: true,
  };
}

/**
 * @param {import('better-sqlite3').Database|null|undefined} db
 * @returns {string|null}
 */
export function readLastScanNotifyFingerprint(db) {
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(SCAN_NOTIFY_FP_KV_KEY);
    return row?.value != null ? String(row.value) : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database|null|undefined} db
 * @param {string} fingerprint
 */
export function writeLastScanNotifyFingerprint(db, fingerprint) {
  if (!db || fingerprint == null || fingerprint === '') return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SCAN_NOTIFY_FP_KV_KEY, String(fingerprint), now);
}

export default {
  SCAN_NOTIFY_FP_KV_KEY,
  buildScanNotifyFingerprint,
  isEmptyScanSummary,
  shouldNotifyScanSummary,
  readLastScanNotifyFingerprint,
  writeLastScanNotifyFingerprint,
};
