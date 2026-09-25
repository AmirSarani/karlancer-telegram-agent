/**
 * Execution mode + automation settings — persisted in SQLite kv (no heavy migration).
 * Default: Manual. Auto OFF unless matching Rules.
 */
import crypto from 'node:crypto';

export const SETTINGS_KV_KEY = 'agent_execution_settings';
export const MODES = Object.freeze(['manual', 'assisted', 'auto']);
/** Chat engagement AI modes (Persian UX) — independent of execution mode. */
export const CHAT_AI_MODES = Object.freeze(['full_manual', 'pick_to_answer', 'full_auto']);
/** @typedef {'full_manual'|'pick_to_answer'|'full_auto'} ChatAiMode */

/** @typedef {'manual'|'assisted'|'auto'} ExecutionMode */

/**
 * Safe defaults — conservative; auto never unlimited.
 * @returns {import('./agent-settings.js').AgentSettings}
 */
export function defaultAgentSettings() {
  return {
    mode: 'manual',
    /** AI chat engagement: full_manual | pick_to_answer | full_auto */
    chatAiMode: 'full_manual',
    emergencyStop: false,
    emergencyStoppedAt: null,
    toggles: {
      autoReplyMessages: false,
      autoSubmitBids: false,
      /** Only meaningful in Assisted/Auto; still OFF until owner enables */
      autoMarkNotificationsRead: false,
    },
    limits: {
      maxAutoMessagesPerDay: 5,
      maxAutoBidsPerDay: 10,
    },
    blacklist: {
      rooms: [],
      users: [],
      keywords: [],
    },
    rules: {
      messageAuto: {
        enabled: false,
        /** Scoring not fully available → stay OFF until configured */
        matchScoreThreshold: null,
        keywords: [],
        budgetMin: null,
        clientStatus: null,
        scoringAvailable: false,
      },
      bidAuto: {
        enabled: false,
        categoryMatch: [],
        budgetThreshold: null,
        noExistingBid: true,
        confidenceThreshold: null,
        scoringAvailable: false,
      },
    },
    /** Chat pricing / negotiation limits (Toman). */
    pricing: {
      maxDiscountPct: 10,
      priceFloorToman: null,
    },
    /** Minimum AI analysis confidence (0..1) for a chat reply to be auto-sent. */
    autoMinConfidence: 0.6,
    /** Show Telegram approval card for first N auto actions each day */
    approvalPreviewFirstN: 3,
    autoShowCardWhenRiskMediumPlus: true,
    updatedAt: null,
  };
}

/**
 * Deep-merge partial into defaults (shallow for nested known keys).
 * @param {object|null|undefined} raw
 */
export function normalizeAgentSettings(raw) {
  const d = defaultAgentSettings();
  if (!raw || typeof raw !== 'object') return d;
  const mode = MODES.includes(raw.mode) ? raw.mode : d.mode;
  const chatAiMode = CHAT_AI_MODES.includes(raw.chatAiMode) ? raw.chatAiMode : d.chatAiMode;
  const toggles = { ...d.toggles, ...(raw.toggles || {}) };
  const limits = {
    maxAutoMessagesPerDay: clampInt(
      raw.limits?.maxAutoMessagesPerDay,
      d.limits.maxAutoMessagesPerDay,
      0,
      100
    ),
    maxAutoBidsPerDay: clampInt(raw.limits?.maxAutoBidsPerDay, d.limits.maxAutoBidsPerDay, 0, 100),
  };
  const blacklist = {
    rooms: asStringList(raw.blacklist?.rooms ?? d.blacklist.rooms),
    users: asStringList(raw.blacklist?.users ?? d.blacklist.users),
    keywords: asStringList(raw.blacklist?.keywords ?? d.blacklist.keywords),
  };
  const messageAuto = {
    ...d.rules.messageAuto,
    ...(raw.rules?.messageAuto || {}),
    enabled: Boolean(raw.rules?.messageAuto?.enabled),
    keywords: asStringList(raw.rules?.messageAuto?.keywords ?? []),
    scoringAvailable: Boolean(raw.rules?.messageAuto?.scoringAvailable),
  };
  const bidAuto = {
    ...d.rules.bidAuto,
    ...(raw.rules?.bidAuto || {}),
    enabled: Boolean(raw.rules?.bidAuto?.enabled),
    categoryMatch: asStringList(raw.rules?.bidAuto?.categoryMatch ?? []),
    scoringAvailable: Boolean(raw.rules?.bidAuto?.scoringAvailable),
    noExistingBid: raw.rules?.bidAuto?.noExistingBid !== false,
  };
  return {
    mode,
    chatAiMode,
    emergencyStop: Boolean(raw.emergencyStop),
    emergencyStoppedAt: raw.emergencyStoppedAt || null,
    toggles: {
      autoReplyMessages: Boolean(toggles.autoReplyMessages),
      autoSubmitBids: Boolean(toggles.autoSubmitBids),
      autoMarkNotificationsRead: Boolean(toggles.autoMarkNotificationsRead),
    },
    limits,
    blacklist,
    rules: { messageAuto, bidAuto },
    pricing: {
      maxDiscountPct: clampInt(raw.pricing?.maxDiscountPct, d.pricing.maxDiscountPct, 0, 50),
      priceFloorToman:
        raw.pricing?.priceFloorToman != null && Number(raw.pricing.priceFloorToman) > 0
          ? Math.round(Number(raw.pricing.priceFloorToman))
          : null,
    },
    autoMinConfidence: clampFloat(raw.autoMinConfidence, d.autoMinConfidence, 0, 1),
    approvalPreviewFirstN: clampInt(raw.approvalPreviewFirstN, d.approvalPreviewFirstN, 0, 50),
    autoShowCardWhenRiskMediumPlus: raw.autoShowCardWhenRiskMediumPlus !== false,
    updatedAt: raw.updatedAt || null,
  };
}

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampFloat(v, fallback, min, max) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function asStringList(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ tenantId?: string }} [opts]
 */
export function createAgentSettingsStore(db, { tenantId = 'default' } = {}) {
  const key = tenantId === 'default' ? SETTINGS_KV_KEY : `${SETTINGS_KV_KEY}:${tenantId}`;

  function read() {
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
      if (!row?.value) return defaultAgentSettings();
      return normalizeAgentSettings(JSON.parse(row.value));
    } catch {
      return defaultAgentSettings();
    }
  }

  function write(next) {
    const normalized = normalizeAgentSettings({
      ...next,
      updatedAt: new Date().toISOString(),
    });
    const now = normalized.updatedAt;
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(normalized), now);
    return normalized;
  }

  function update(patch) {
    const cur = read();
    return write({
      ...cur,
      ...patch,
      toggles: { ...cur.toggles, ...(patch.toggles || {}) },
      limits: { ...cur.limits, ...(patch.limits || {}) },
      pricing: { ...cur.pricing, ...(patch.pricing || {}) },
      blacklist: {
        rooms: patch.blacklist?.rooms ?? cur.blacklist.rooms,
        users: patch.blacklist?.users ?? cur.blacklist.users,
        keywords: patch.blacklist?.keywords ?? cur.blacklist.keywords,
      },
      rules: {
        messageAuto: { ...cur.rules.messageAuto, ...(patch.rules?.messageAuto || {}) },
        bidAuto: { ...cur.rules.bidAuto, ...(patch.rules?.bidAuto || {}) },
      },
    });
  }

  return {
    tenantId,
    get: read,
    set: write,
    update,
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error('invalid_mode');
      return update({ mode });
    },
    setChatAiMode(chatAiMode) {
      if (!CHAT_AI_MODES.includes(chatAiMode)) throw new Error('invalid_chat_ai_mode');
      return update({ chatAiMode });
    },
    setToggle(name, value) {
      const allowed = ['autoReplyMessages', 'autoSubmitBids', 'autoMarkNotificationsRead'];
      if (!allowed.includes(name)) throw new Error('invalid_toggle');
      return update({ toggles: { [name]: Boolean(value) } });
    },
    emergencyStop() {
      return update({
        emergencyStop: true,
        emergencyStoppedAt: new Date().toISOString(),
        mode: 'manual',
        chatAiMode: 'full_manual',
        toggles: {
          autoReplyMessages: false,
          autoSubmitBids: false,
          autoMarkNotificationsRead: false,
        },
      });
    },
    clearEmergency({ keepManual = true } = {}) {
      return update({
        emergencyStop: false,
        emergencyStoppedAt: null,
        mode: keepManual ? 'manual' : undefined,
      });
    },
  };
}

/**
 * Append searchable auto-action audit (uses existing audit_log).
 * @param {import('better-sqlite3').Database} db
 * @param {object} entry
 */
export function appendAutomationAudit(db, entry) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const {
    tenantId = 'default',
    actor = 'system',
    action,
    resultCode = 'ok',
    correlationId = null,
    detail = {},
  } = entry;
  db.prepare(
    `INSERT INTO audit_log (
      id, tenant_id, actor, action, tool, input_hash, result_code, correlation_id, created_at, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tenantId,
    actor,
    action,
    'permission_gate',
    null,
    resultCode,
    correlationId,
    now,
    JSON.stringify({
      ...detail,
      time: now,
    })
  );
  return { id, createdAt: now };
}

/**
 * Count today's auto actions by kind from audit_log.
 * @param {import('better-sqlite3').Database} db
 * @param {{ tenantId?: string, day?: string }} [opts]
 */
export function getTodayAutoCounts(db, { tenantId = 'default', day = null } = {}) {
  const d = day || new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT action, detail_json FROM audit_log
       WHERE tenant_id = ? AND tool = 'permission_gate'
         AND created_at >= ? AND created_at < ?
         AND action LIKE 'auto.%'`
    )
    .all(tenantId, `${d}T00:00:00.000Z`, `${d}T23:59:59.999Z`);
  let messages = 0;
  let bids = 0;
  let markRead = 0;
  let other = 0;
  for (const r of rows) {
    if (r.action === 'auto.messages.send') messages += 1;
    else if (r.action === 'auto.bids.submit') bids += 1;
    else if (r.action === 'auto.notifications.mark_read' || r.action === 'auto.messages.mark_seen')
      markRead += 1;
    else other += 1;
  }
  return { day: d, messages, bids, markRead, other, total: rows.length };
}

/**
 * Recent automation audit rows for bot search/list.
 */
export function listAutomationAudit(db, { tenantId = 'default', limit = 20, actionPrefix = 'auto.' } = {}) {
  return db
    .prepare(
      `SELECT id, actor, action, result_code, created_at, detail_json, correlation_id
       FROM audit_log
       WHERE tenant_id = ? AND tool = 'permission_gate' AND action LIKE ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(tenantId, `${actionPrefix}%`, Math.min(50, Math.max(1, limit)));
}

export default createAgentSettingsStore;
