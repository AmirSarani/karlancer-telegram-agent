const SECRET_KEYS =
  /^(authorization|cookie|token|access_token|refresh_token|password|passwd|pwd|api_?key|secret|bearer|phone|mobile|telegram_secrets_key|karlancer_access_token)$/i;

/** Inline Bearer / Authorization header values */
const SECRET_INLINE =
  /(Bearer\s+)[A-Za-z0-9._\-+=\/|]+/gi;

/** Authorization: <scheme> <token> or raw header dumps */
const AUTH_HEADER_INLINE =
  /(Authorization\s*[:=]\s*)([^\s,;]+(?:\s+[^\s,;]+)?)/gi;

/** password=... / "password":"..." style leaks */
const PASSWORD_INLINE =
  /((?:password|passwd|pwd)\s*[:=]\s*["']?)([^\s"',}\\]+)/gi;

/** Iranian mobile patterns (09xxxxxxxxx / +98…) — redact mid-string */
const PHONE_INLINE =
  /(?:\+98|0098|98)?0?9\d{9}\b/g;

export function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s.replace(SECRET_INLINE, '$1[REDACTED]');
  out = out.replace(AUTH_HEADER_INLINE, '$1[REDACTED]');
  out = out.replace(PASSWORD_INLINE, '$1[REDACTED]');
  out = out.replace(PHONE_INLINE, '[REDACTED_PHONE]');
  return out;
}

export function redactDeep(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) out[k] = '[REDACTED]';
    else out[k] = redactDeep(v, depth + 1);
  }
  return out;
}

/**
 * Require https:// and (optionally) an allowlisted host.
 * Used for Karlancer base URL and absolute outbound URLs.
 */
export function assertAllowedUrl(urlString, allowedHosts = ['www.karlancer.com', 'karlancer.com']) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error('invalid_url');
  }
  if (u.protocol !== 'https:') throw new Error('https_required');
  if (!allowedHosts.includes(u.hostname)) throw new Error('host_not_allowed');
  return u;
}

/**
 * Reject any non-HTTPS base URL (Karlancer, OpenAI-compatible, custom Telegram API root).
 * @param {string} name env / config field name
 * @param {string} urlString
 * @returns {URL}
 */
export function assertHttpsOnlyUrl(name, urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error(`${name}_invalid_url`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(`${name}_https_required`);
  }
  return u;
}

export default {
  redactString,
  redactDeep,
  assertAllowedUrl,
  assertHttpsOnlyUrl,
};
