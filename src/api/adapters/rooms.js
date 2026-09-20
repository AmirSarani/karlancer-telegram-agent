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
      const meta = payload?.data || payload || {};
      const pagination = {
        currentPage: meta.current_page ?? (Number(page) || 1),
        lastPage: meta.last_page ?? null,
        perPage: meta.per_page ?? null,
        total: meta.total ?? list.length,
      };
      return {
        page: Number(page) || 1,
        rooms: list.map(normalizeRoom).filter(Boolean),
        pagination,
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
