/** Rooms list — extension-confirmed GET /api/rooms/?page=N; archive from HAR GET /api/rooms/archive */
import { normalizeRoom } from '../models/room.js';
import { normalizePagination } from '../util/pagination.js';

export function createRoomsAdapter(client) {
  return {
    async list({ page = 1 } = {}) {
      const res = await client.get(`/api/rooms/?page=${Number(page) || 1}`);
      return shapeRoomsPage(res.data, page);
    },

    /** HAR-confirmed archived conversations */
    async listArchived({ page = 1 } = {}) {
      const res = await client.get(`/api/rooms/archive?page=${Number(page) || 1}`);
      return shapeRoomsPage(res.data, page);
    },
  };
}

function shapeRoomsPage(payload, page) {
  const rooms =
    payload?.data?.data ||
    payload?.data?.rooms ||
    payload?.data ||
    payload?.rooms ||
    [];
  const list = Array.isArray(rooms) ? rooms : [];
  const meta = payload?.data || payload || {};
  const pagination = normalizePagination(meta, {
    page: Number(page) || 1,
    fallbackTotal: list.length,
  });
  return {
    page: Number(page) || 1,
    rooms: list.map(normalizeRoom).filter(Boolean),
    pagination,
    raw: payload,
  };
}
