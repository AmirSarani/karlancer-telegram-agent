/** Current user try-list */
export function createUserAdapter(client) {
  const candidates = ['/api/user', '/api/auth/user', '/api/profile', '/api/account'];
  return {
    async me() {
      const attempts = [];
      for (const path of candidates) {
        try {
          const res = await client.get(path, { retries: 0 });
          const j = res.data;
          const id = j?.data?.id ?? j?.data?.user?.id ?? j?.id ?? j?.user?.id;
          attempts.push({ path, ok: true, status: res.status });
          if (id != null) {
            return { id: String(id), raw: j, endpoint: path, attempts };
          }
        } catch (e) {
          attempts.push({ path, ok: false, status: e.status, code: e.code });
        }
      }
      return {
        id: null,
        status: 'blocked_by_missing_api',
        reason: 'user_endpoint_unverified',
        attempts,
      };
    },
  };
}
