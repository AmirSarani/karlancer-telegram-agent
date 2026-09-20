/** Rooms list — extension-confirmed GET /api/rooms/?page=N */
export function createRoomsAdapter(client) {
  return {
    async list({ page = 1 } = {}) {
      const res = await client.get(`/api/rooms/?page=${Number(page) || 1}`);
      const payload = res.data;
      const rooms =
        payload?.data?.data ||
        payload?.data?.rooms ||
        payload?.data ||
        payload?.rooms ||
        [];
      const list = Array.isArray(rooms) ? rooms : [];
      return {
        page: Number(page) || 1,
        rooms: list.map(normalizeRoom),
        raw: payload,
      };
    },
  };
}

function normalizeRoom(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    id: r.id != null ? String(r.id) : null,
    lastMessage: String(r.last_message || r.lastMessage || r.message || '').trim(),
    unread: r.unread_count ?? r.unread ?? r.unseen ?? null,
    updatedAt: r.updated_at || r.updatedAt || null,
    title: r.title || r.name || r.user_name || r.sender_name || null,
    raw: r,
  };
}
