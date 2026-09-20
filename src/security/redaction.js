const SECRET_KEYS = /^(authorization|cookie|token|access_token|refresh_token|password|api_?key|secret|bearer)$/i;
const SECRET_INLINE = /(Bearer\s+)[A-Za-z0-9._\-+=\/]+/gi;

export function redactString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(SECRET_INLINE, '$1[REDACTED]');
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

/** Block SSRF: only allow karlancer hostnames for adapter base. */
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
