/**
 * Current user / profile.
 * HAR-confirmed: GET /api/dashboard includes authenticated user + wallet summary.
 * Legacy try-list GETs retained as fallback only.
 */
import { normalizeUser } from '../models/user.js';

export function createUserAdapter(client) {
  const fallbackCandidates = ['/api/user', '/api/auth/user', '/api/profile', '/api/account'];
  return {
    async me() {
      // Preferred: dashboard (HAR 200)
      try {
        const res = await client.get('/api/dashboard', { retries: 0 });
        const j = res.data;
        const userRaw = j?.data?.user || j?.data?.profile || j?.user || null;
        const id = userRaw?.id ?? j?.data?.id ?? j?.id;
        if (id != null || userRaw) {
          return {
            id: id != null ? String(id) : null,
            user: userRaw ? normalizeUser(userRaw) : null,
            wallet: j?.data?.wallet || null,
            raw: j,
            endpoint: '/api/dashboard',
            status: 'ok',
            source: 'har_dashboard',
          };
        }
      } catch {
        /* fall through */
      }

      const attempts = [];
      for (const path of fallbackCandidates) {
        try {
          const res = await client.get(path, { retries: 0 });
          const j = res.data;
          const id = j?.data?.id ?? j?.data?.user?.id ?? j?.id ?? j?.user?.id;
          attempts.push({ path, ok: true, status: res.status });
          if (id != null) {
            const userRaw = j?.data?.user || j?.data || j?.user || j;
            return {
              id: String(id),
              user: normalizeUser(userRaw),
              raw: j,
              endpoint: path,
              attempts,
              status: 'partial',
              note: 'endpoint discovered via GET try-list; prefer /api/dashboard',
            };
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

    async dashboard() {
      const res = await client.get('/api/dashboard');
      const data = res.data?.data || res.data || {};
      return {
        user: data.user ? normalizeUser(data.user) : null,
        wallet: data.wallet || null,
        stats: data.stats || data.statistics || null,
        raw: res.data,
      };
    },
  };
}
