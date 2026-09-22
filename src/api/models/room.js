/** @param {object} r */
export function normalizeRoom(r) {
  if (!r || typeof r !== 'object') return null;
  const guestName = r.guest_name || r.guestName || null;
  return {
    id: r.id != null ? String(r.id) : null,
    lastMessage: String(
      r.last_message || r.lastMessage || r.last_message_preview || r.message || ''
    ).trim(),
    unread: r.unread_count ?? r.unread ?? r.unseen ?? null,
    updatedAt: r.updated_at || r.updatedAt || null,
    title: r.title || r.name || guestName || r.user_name || r.sender_name || null,
    guestName: guestName ? String(guestName) : null,
    userId: r.user_id != null ? String(r.user_id) : r.guest_id != null ? String(r.guest_id) : null,
    isOnline: r.is_online ?? r.isOnline ?? null,
    isOpen: r.is_open ?? r.isOpen ?? null,
    isArchived: r.is_archived ?? r.isArchived ?? null,
    avatar: r.avatar || null,
    raw: r,
  };
}
