/** Bookmarks — HAR GET /api/bookmarks/project/ids and /api/bookmarks/freelancer/ids */
export function createBookmarksAdapter(client) {
  return {
    async projectIds() {
      const res = await client.get('/api/bookmarks/project/ids');
      const data = res.data?.data ?? res.data ?? [];
      const ids = Array.isArray(data) ? data.map(String) : [];
      return { ids, raw: res.data };
    },
    async freelancerIds() {
      const res = await client.get('/api/bookmarks/freelancer/ids');
      const data = res.data?.data ?? res.data ?? [];
      const ids = Array.isArray(data) ? data.map(String) : [];
      return { ids, raw: res.data };
    },
  };
}
