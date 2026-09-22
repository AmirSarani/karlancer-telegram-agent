/** @param {object} n */
export function normalizeNotification(n) {
  if (!n || typeof n !== 'object') return null;
  return {
    id: n.id != null ? String(n.id) : null,
    title: n.title || n.subject || null,
    body: n.body || n.message || n.text || n.content || null,
    read: n.read ?? n.is_read ?? n.seen ?? null,
    createdAt: n.created_at || n.createdAt || null,
    type: n.type || n.kind || null,
    raw: n,
  };
}
