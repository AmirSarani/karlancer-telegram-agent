/**
 * Per-room KV state: poll cursors, drafts, owner notes, decisions.
 * No PII dumps beyond what the API already returned into content fields.
 */
import { redactDeep } from '../security/redaction.js';

function nowIso() {
  return new Date().toISOString();
}

function kvGet(db, key) {
  try {
    const row = db.prepare(`SELECT value, updated_at FROM kv WHERE key = ?`).get(key);
    if (!row?.value) return null;
    try {
      return { value: JSON.parse(row.value), updatedAt: row.updated_at };
    } catch {
      return { value: row.value, updatedAt: row.updated_at };
    }
  } catch {
    return null;
  }
}

function kvSet(db, key, value) {
  const ts = nowIso();
  const serialized = typeof value === 'string' ? value : JSON.stringify(redactDeep(value));
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, serialized, ts);
  return ts;
}

const cursorKey = (roomId) => `room:${roomId}:cursor`;
const draftKey = (roomId) => `room:${roomId}:draft`;
const noteKey = (roomId) => `room:${roomId}:note`;
const decisionKey = (roomId) => `room:${roomId}:decision`;
const cardKey = (roomId) => `room:${roomId}:card`;
const seenKey = (roomId) => `room:${roomId}:seen_ids`;
const pendingIndexKey = 'rooms:pending_decisions';
const pollHealthKey = 'messages_poll_health';
const awaitingNoteKey = (userId) => `tg:awaiting_note:${userId}`;
const threadKey = (roomId) => `room:${roomId}:thread`;
const answeredIndexKey = 'rooms:answered';

/** @typedef {'new'|'pending'|'answered'|'active_thread'} RoomPhase */

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createRoomState(db) {
  return {
    getCursor(roomId) {
      const row = kvGet(db, cursorKey(roomId));
      return row?.value && typeof row.value === 'object' ? row.value : null;
    },

    setCursor(roomId, cursor) {
      return kvSet(db, cursorKey(roomId), {
        lastUpdatedAt: cursor?.lastUpdatedAt || null,
        lastMessageId: cursor?.lastMessageId || null,
        lastPolledAt: nowIso(),
      });
    },

    getSeenIds(roomId) {
      const row = kvGet(db, seenKey(roomId));
      const arr = Array.isArray(row?.value) ? row.value : row?.value?.ids || [];
      return new Set(arr.map(String));
    },

    addSeenIds(roomId, ids) {
      const set = this.getSeenIds(roomId);
      for (const id of ids || []) {
        if (id != null) set.add(String(id));
      }
      // Cap to last 500 ids to keep kv small
      const arr = [...set];
      const trimmed = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
      kvSet(db, seenKey(roomId), { ids: trimmed });
      return new Set(trimmed);
    },

    getDraft(roomId) {
      const row = kvGet(db, draftKey(roomId));
      return row?.value && typeof row.value === 'object' ? row.value : null;
    },

    setDraft(roomId, draft) {
      return kvSet(db, draftKey(roomId), {
        text: String(draft?.text || ''),
        source: draft?.source || 'template',
        updatedAt: nowIso(),
        meta: draft?.meta || {},
      });
    },

    getNote(roomId) {
      const row = kvGet(db, noteKey(roomId));
      return row?.value && typeof row.value === 'object' ? row.value : null;
    },

    setNote(roomId, noteText) {
      return kvSet(db, noteKey(roomId), {
        text: String(noteText || '').slice(0, 4000),
        updatedAt: nowIso(),
      });
    },

    getDecision(roomId) {
      const row = kvGet(db, decisionKey(roomId));
      return row?.value && typeof row.value === 'object' ? row.value : null;
    },

    setDecision(roomId, decision) {
      const ts = kvSet(db, decisionKey(roomId), {
        status: decision?.status || 'pending', // pending | approved | rejected | blocked
        updatedAt: nowIso(),
        detail: decision?.detail || null,
      });
      this._syncPendingIndex(roomId, decision?.status || 'pending');
      return ts;
    },

    getCard(roomId) {
      const row = kvGet(db, cardKey(roomId));
      return row?.value && typeof row.value === 'object' ? row.value : null;
    },

    setCard(roomId, card) {
      const ts = kvSet(db, cardKey(roomId), card);
      const status = this.getDecision(roomId)?.status || 'pending';
      if (status === 'pending' || status === 'blocked') {
        this._syncPendingIndex(roomId, 'pending');
      }
      return ts;
    },

    _syncPendingIndex(roomId, status) {
      const row = kvGet(db, pendingIndexKey);
      /** @type {string[]} */
      let ids = Array.isArray(row?.value?.ids) ? row.value.ids.map(String) : [];
      const rid = String(roomId);
      if (status === 'pending' || status === 'blocked') {
        if (!ids.includes(rid)) ids.push(rid);
      } else {
        ids = ids.filter((x) => x !== rid);
      }
      // Cap index
      if (ids.length > 200) ids = ids.slice(-200);
      kvSet(db, pendingIndexKey, { ids, updatedAt: nowIso() });
    },

    listPendingRoomIds() {
      const row = kvGet(db, pendingIndexKey);
      return Array.isArray(row?.value?.ids) ? row.value.ids.map(String) : [];
    },

    pendingCount() {
      return this.listPendingRoomIds().length;
    },

    setPollHealth(health) {
      return kvSet(db, pollHealthKey, {
        ...health,
        updatedAt: nowIso(),
      });
    },

    getPollHealth() {
      const row = kvGet(db, pollHealthKey);
      return row?.value && typeof row.value === 'object' ? row.value : null;
    },

    setAwaitingNote(userId, roomId) {
      return kvSet(db, awaitingNoteKey(userId), { roomId: String(roomId), at: nowIso() });
    },

    getAwaitingNote(userId) {
      const row = kvGet(db, awaitingNoteKey(userId));
      return row?.value?.roomId ? String(row.value.roomId) : null;
    },

    clearAwaitingNote(userId) {
      try {
        db.prepare(`DELETE FROM kv WHERE key = ?`).run(awaitingNoteKey(userId));
      } catch {
        /* ignore */
      }
    },

    /**
     * Continuum memory for a chat thread.
     * @returns {{
     *   phase: RoomPhase,
     *   summary: string|null,
     *   lastSentText: string|null,
     *   lastDraftText: string|null,
     *   lastSentAt: string|null,
     *   lastInboundAt: string|null,
     *   notes: string|null,
     *   suggestedPrice: number|null,
     *   pendingSendJobId: string|null,
     *   followUpCount: number,
     *   lastFollowUpAt: string|null,
     *   updatedAt: string|null,
     * }}
     */
    getThread(roomId) {
      const row = kvGet(db, threadKey(roomId));
      const v = row?.value && typeof row.value === 'object' ? row.value : {};
      return {
        phase: v.phase || 'new',
        summary: v.summary || null,
        lastSentText: v.lastSentText || null,
        lastDraftText: v.lastDraftText || null,
        lastSentAt: v.lastSentAt || null,
        lastInboundAt: v.lastInboundAt || null,
        notes: v.notes || null,
        suggestedPrice: v.suggestedPrice ?? null,
        pendingSendJobId: v.pendingSendJobId || null,
        followUpCount: Number(v.followUpCount) || 0,
        lastFollowUpAt: v.lastFollowUpAt || null,
        updatedAt: v.updatedAt || row?.updatedAt || null,
      };
    },

    setThread(roomId, patch = {}) {
      const cur = this.getThread(roomId);
      const next = {
        ...cur,
        ...patch,
        phase: patch.phase || cur.phase || 'new',
        updatedAt: nowIso(),
      };
      kvSet(db, threadKey(roomId), next);
      if (next.phase === 'answered') this._syncAnsweredIndex(roomId, true);
      else if (patch.phase && patch.phase !== 'answered') this._syncAnsweredIndex(roomId, false);
      return next;
    },

    touchInbound(roomId, { at = null, summary = null } = {}) {
      const cur = this.getThread(roomId);
      const phase =
        cur.phase === 'answered' || cur.phase === 'active_thread' || cur.lastSentAt
          ? 'active_thread'
          : cur.phase === 'new'
            ? 'pending'
            : cur.phase || 'pending';
      return this.setThread(roomId, {
        lastInboundAt: at || nowIso(),
        phase,
        ...(summary != null ? { summary: String(summary).slice(0, 2000) } : {}),
      });
    },

    /**
     * Mark room answered after successful send or owner mark.
     */
    markAnswered(roomId, { lastSentText = null, summary = null } = {}) {
      const draft = this.getDraft(roomId);
      const note = this.getNote(roomId);
      const next = this.setThread(roomId, {
        phase: 'answered',
        lastSentAt: nowIso(),
        lastSentText:
          lastSentText != null
            ? String(lastSentText).slice(0, 4000)
            : draft?.text
              ? String(draft.text).slice(0, 4000)
              : null,
        lastDraftText: draft?.text ? String(draft.text).slice(0, 4000) : null,
        notes: note?.text ? String(note.text).slice(0, 2000) : null,
        ...(summary != null ? { summary: String(summary).slice(0, 2000) } : {}),
      });
      this.setDecision(roomId, { status: 'answered', detail: 'owner_or_send' });
      return next;
    },

    _syncAnsweredIndex(roomId, isAnswered) {
      const row = kvGet(db, answeredIndexKey);
      let ids = Array.isArray(row?.value?.ids) ? row.value.ids.map(String) : [];
      const rid = String(roomId);
      if (isAnswered) {
        if (!ids.includes(rid)) ids.push(rid);
      } else {
        ids = ids.filter((x) => x !== rid);
      }
      if (ids.length > 300) ids = ids.slice(-300);
      kvSet(db, answeredIndexKey, { ids, updatedAt: nowIso() });
    },

    listAnsweredRoomIds() {
      const row = kvGet(db, answeredIndexKey);
      return Array.isArray(row?.value?.ids) ? row.value.ids.map(String) : [];
    },

    answeredCount() {
      return this.listAnsweredRoomIds().length;
    },
  };
}

/**
 * Merge owner note into an existing draft text (deterministic, no LLM).
 * Used when LLM is unavailable or as baseline before AI polish.
 * @param {{ text?: string }} draft
 * @param {string} note
 */
export function mergeNoteIntoDraft(draft, note) {
  const base = String(draft?.text || '').trim();
  const n = String(note || '').trim();
  if (!n) return { text: base, source: draft?.source || 'template' };
  if (!base) {
    return {
      text: n,
      source: 'note_only',
    };
  }
  // Append a short acknowledgement of owner guidance without dumping the note verbatim twice
  const merged = `${base}\n\n—\n(توجه مالک: ${n.slice(0, 500)})`;
  return { text: merged, source: 'template+note' };
}

export default createRoomState;
