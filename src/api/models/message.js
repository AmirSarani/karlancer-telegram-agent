import { normalizeInboundMessage } from '../../agent/message-normalize.js';

/** @param {object} raw */
export function normalizeMessage(raw) {
  const m = normalizeInboundMessage(raw);
  if (!m) return null;
  return {
    id: m.id,
    text: m.text,
    createdAt: m.createdAt,
    projectId: m.projectId,
    userId: m.userId,
    isOwn: m.isOwn,
    projectSlug: m.projectSlug,
    attachments: m.attachments,
    raw: m.raw,
  };
}
