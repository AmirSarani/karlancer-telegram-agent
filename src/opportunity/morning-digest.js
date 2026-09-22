/**
 * Morning digest ~09:00 Asia/Tehran — short summary; quiet if nothing.
 * In-process schedule hook (call from index/worker); respects pause/emergency.
 */
import { formatMorningDigest } from '../telegram/opportunity-ux.js';
import { createOpportunityStore } from './store.js';
import { createAgentSettingsStore } from '../telegram/agent-settings.js';
import { checkTokenHealth } from '../security/token-health.js';

const KV_KEY = 'morning_digest_state';

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {(text: string) => Promise<void>|void} deps.notify
 * @param {{ hasAuth?: boolean, envFile?: string }} [deps.auth]
 * @param {() => number} [deps.pendingApprovals]
 * @param {() => boolean} [deps.isPaused]
 */
export function createMorningDigest(deps) {
  const { db, notify, auth = {}, pendingApprovals = () => 0, isPaused = () => false } = deps;
  let timer = null;

  function readState() {
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(KV_KEY);
      return row?.value ? JSON.parse(row.value) : { lastSentDay: null };
    } catch {
      return { lastSentDay: null };
    }
  }

  function writeState(st) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(KV_KEY, JSON.stringify(st), now);
  }

  /** Tehran calendar day YYYY-MM-DD */
  function tehranDay(d = new Date()) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tehran',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  function tehranHourMinute(d = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Tehran',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(d);
      const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
      const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
      return { hour, minute };
    } catch {
      return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
    }
  }

  async function maybeSend({ force = false } = {}) {
    if (isPaused()) return { sent: false, reason: 'paused' };
    const settings = createAgentSettingsStore(db).get();
    if (settings.emergencyStop && !force) return { sent: false, reason: 'emergency' };

    const day = tehranDay();
    const st = readState();
    if (!force && st.lastSentDay === day) return { sent: false, reason: 'already_sent' };

    const { hour, minute } = tehranHourMinute();
    // Window 09:00–09:20 Tehran
    if (!force && !(hour === 9 && minute < 20)) {
      return { sent: false, reason: 'outside_window' };
    }

    const store = createOpportunityStore(db);
    const opps = store.list({ minScore: 40, limit: 50 }).filter((o) => o.state !== 'IGNORED');
    const scan = store.getScanState();
    const th = checkTokenHealth({
      authOk: auth.hasAuth != null ? Boolean(auth.hasAuth) : null,
      envFile: auth.envFile || null,
    });
    const text = formatMorningDigest({
      opportunityCount: opps.length,
      pendingApprovals: pendingApprovals(),
      sessionHealthy: th.healthy === false ? false : th.warn ? false : th.healthy,
      lastScanAt: scan.lastScanAt,
      force,
    });
    if (!text) return { sent: false, reason: 'quiet' };

    await notify(text);
    writeState({ lastSentDay: day, lastSentAt: new Date().toISOString() });
    return { sent: true, day };
  }

  return {
    maybeSend,
    start(pollMs = 60_000) {
      timer = setInterval(() => {
        maybeSend().catch(() => {});
      }, pollMs);
      if (typeof timer.unref === 'function') timer.unref();
      maybeSend().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export default createMorningDigest;
