/**
 * Room messages — confirmed GET /api/rooms/{id}/messages-pg
 * Send — try-list (unverified) from extension shared/room-messages.js
 */
import { KarlancerApiError } from '../errors.js';

export function extractMessageList(apiJson) {
  if (!apiJson) return [];
  const candidates = [
    apiJson?.data?.messages?.data,
    apiJson?.data?.messages,
    apiJson?.data?.data,
    apiJson?.data,
    apiJson?.messages?.data,
    apiJson?.messages,
    apiJson,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

export function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ?? raw.message_id ?? raw.uuid ?? null;
  const text = String(
    raw.message ?? raw.text ?? raw.body ?? raw.content ?? raw.last_message ?? ''
  ).trim();
  let isOwn = null;
  if (typeof raw.is_me === 'boolean') isOwn = raw.is_me;
  else if (typeof raw.is_mine === 'boolean') isOwn = raw.is_mine;
  else if (typeof raw.from_me === 'boolean') isOwn = raw.from_me;

  return {
    id: id != null ? String(id) : null,
    text,
    createdAt: raw.created_at || raw.createdAt || raw.date || null,
    projectId: raw.project_id != null ? String(raw.project_id) : raw.projectId != null ? String(raw.projectId) : null,
    userId: raw.user_id != null ? String(raw.user_id) : raw.userId != null ? String(raw.userId) : null,
    isOwn,
    raw,
  };
}

export function getSendApiCandidates(roomId, text) {
  const message = String(text || '');
  const rid = Number(roomId) || roomId;
  const payloads = [
    { message },
    { text: message },
    { body: message },
    { content: message },
    { message, room_id: rid },
    { text: message, room_id: rid },
  ];
  const endpoints = [
    `/api/rooms/${roomId}/messages`,
    `/api/rooms/${roomId}/message`,
    `/api/messages`,
    `/api/rooms/messages`,
  ];
  /** @type {{path:string,body:object,shape:string}[]} */
  const candidates = [];
  for (const path of endpoints) {
    for (const body of payloads) {
      candidates.push({ path, body, shape: Object.keys(body).join(',') });
    }
  }
  return candidates;
}

export function createMessagesAdapter(client) {
  return {
    async list(roomId, { page = 1 } = {}) {
      if (!roomId) throw new KarlancerApiError('invalid_input', 'roomId required');
      const res = await client.get(`/api/rooms/${roomId}/messages-pg?page=${Number(page) || 1}`);
      const rawList = extractMessageList(res.data);
      return {
        roomId: String(roomId),
        page: Number(page) || 1,
        messages: rawList.map(normalizeMessage).filter(Boolean),
        raw: res.data,
      };
    },

    /**
     * Unverified send — returns blocked_by_missing_api when all attempts fail.
     * Caller MUST require human approval before invoking.
     */
    async send(roomId, text) {
      if (!roomId) throw new KarlancerApiError('invalid_input', 'roomId required');
      if (!text || !String(text).trim()) throw new KarlancerApiError('invalid_input', 'text required');
      const result = await client.tryPost(getSendApiCandidates(roomId, text), { label: 'send_message' });
      if (result.ok) {
        return {
          ok: true,
          roomId: String(roomId),
          endpoint: result.path,
          shape: result.shape,
          attempts: result.attempts,
        };
      }
      return {
        ok: false,
        status: 'blocked_by_missing_api',
        reason: 'definitive_chat_send_endpoint_unverified',
        attempts: result.attempts,
        error: result.error?.message || 'send failed',
      };
    },

    async markSeen(roomId) {
      const candidates = [
        { path: `/api/rooms/${roomId}/seen`, body: {}, shape: 'empty' },
        { path: `/api/rooms/${roomId}/read`, body: {}, shape: 'empty' },
        { path: `/api/rooms/seen`, body: { room_id: roomId }, shape: 'room_id' },
        { path: `/api/messages/seen`, body: { room_id: roomId }, shape: 'room_id' },
      ];
      return client.tryPost(candidates, { label: 'mark_seen' });
    },
  };
}
