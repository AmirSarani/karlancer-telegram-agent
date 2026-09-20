/**
 * Room messages — confirmed GET /api/rooms/{id}/messages-pg
 * Send — VerifiedMutationContract only (no try-list POST).
 */
import { KarlancerApiError } from '../errors.js';
import {
  executeVerifiedMutation,
  getVerifiedMutation,
  messageIdempotencyKey,
} from '../contracts/verified-mutation.js';

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
    projectId:
      raw.project_id != null
        ? String(raw.project_id)
        : raw.projectId != null
          ? String(raw.projectId)
          : null,
    userId:
      raw.user_id != null ? String(raw.user_id) : raw.userId != null ? String(raw.userId) : null,
    isOwn,
    raw,
  };
}

/**
 * Documented extension try-list paths — for HAR guidance / audit ONLY.
 * MUST NOT be used to POST in production.
 */
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
      const nested = res.data?.data?.messages || {};
      const pagination = {
        currentPage: nested.current_page ?? (Number(page) || 1),
        lastPage: nested.last_page ?? null,
        perPage: nested.per_page ?? null,
        total: nested.total ?? rawList.length,
      };
      return {
        roomId: String(roomId),
        page: Number(page) || 1,
        messages: rawList.map(normalizeMessage).filter(Boolean),
        pagination,
        raw: res.data,
      };
    },

    /**
     * Send message — ONLY via VerifiedMutationContract.
     * Until evidence: NO POST.
     */
    async send(roomId, text, { operationId } = {}) {
      if (!roomId) throw new KarlancerApiError('invalid_input', 'roomId required');
      if (!text || !String(text).trim()) throw new KarlancerApiError('invalid_input', 'text required');

      const contract = getVerifiedMutation('messages.send');
      const opId = messageIdempotencyKey({
        roomId,
        text,
        operationId: operationId || undefined,
      });

      if (!contract) {
        return {
          ok: false,
          status: 'blocked_by_missing_api',
          reason: 'definitive_chat_send_endpoint_unverified',
          posted: false,
          operationId: opId,
          roomId: String(roomId),
          hint: 'Capture authenticated HAR with 2xx message POST; register VerifiedMutationContract. See docs/HAR_CAPTURE.md',
          // Expose candidate paths for operator HAR guidance only — not attempted
          candidatePathsForHarOnly: getSendApiCandidates(roomId, text).map((c) => c.path).filter((v, i, a) => a.indexOf(v) === i),
        };
      }

      return executeVerifiedMutation(client, 'messages.send', {
        operationId: opId,
        pathParams: { roomId },
        payload: { message: String(text) },
      });
    },

    /**
     * Mark seen — unverified; no production POST until contract registered.
     */
    async markSeen(roomId) {
      const contract = getVerifiedMutation('messages.mark_seen');
      if (!contract) {
        return {
          ok: false,
          status: 'blocked_by_missing_api',
          reason: 'mark_seen_endpoint_unverified',
          posted: false,
          roomId: String(roomId),
        };
      }
      return executeVerifiedMutation(client, 'messages.mark_seen', {
        operationId: `seen:${roomId}:${Date.now()}`,
        pathParams: { roomId },
        payload: {},
      });
    },
  };
}
