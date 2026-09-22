/**
 * Karlancer phone login (session renewal).
 * Live shape: POST /api/login/phone
 * body keys (captured): phone, password, unregistered_project_token,
 *   unregistered_service_token, role
 * response: { status, data: { access_token, token_type, user, ... } }
 * Never log phone/password/token.
 */
import { KarlancerApiError } from '../errors.js';

/**
 * @param {import('../client.js').KarlancerClient} client
 */
export function createAuthAdapter(client) {
  return {
    /**
     * @param {{ phone: string, password: string, role?: string }} creds
     * @returns {Promise<{ accessToken: string, tokenType: string|null, userId: string|null }>}
     */
    async loginWithPhone({ phone, password, role = '' }) {
      const phoneNorm = String(phone || '').trim();
      const passwordRaw = String(password || '');
      if (!phoneNorm || !passwordRaw) {
        throw new KarlancerApiError('validation', 'phone and password required');
      }

      const body = {
        phone: phoneNorm,
        password: passwordRaw,
        unregistered_project_token: null,
        unregistered_service_token: null,
        role: role == null ? '' : String(role),
      };

      const res = await client.post('/api/login/phone', body, {
        auth: false,
        mutation: true,
        retries: 0,
      });

      const token = extractAccessToken(res?.data);
      if (!token) {
        throw new KarlancerApiError('login_no_token', 'Login response missing access_token', {
          status: res?.status,
          path: '/api/login/phone',
        });
      }

      const data =
        res.data?.data && typeof res.data.data === 'object' ? res.data.data : res.data || {};
      const userId =
        data?.user?.id != null
          ? String(data.user.id)
          : data?.user_id != null
            ? String(data.user_id)
            : null;
      const tokenType =
        data?.token_type != null
          ? String(data.token_type)
          : data?.tokenType != null
            ? String(data.tokenType)
            : 'Bearer';

      return { accessToken: token, tokenType, userId };
    },
  };
}

/**
 * @param {unknown} payload
 * @returns {string|null}
 */
export function extractAccessToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const root = /** @type {Record<string, any>} */ (payload);
  const candidates = [
    root?.data?.access_token,
    root?.access_token,
    root?.data?.token,
    root?.token,
    root?.data?.auth?.access_token,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

export default createAuthAdapter;
