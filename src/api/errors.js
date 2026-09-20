export class KarlancerApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, path?: string, body?: unknown, attempts?: unknown[] }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'KarlancerApiError';
    this.code = code;
    this.status = extra.status;
    this.path = extra.path;
    this.body = extra.body;
    this.attempts = extra.attempts;
  }
}

export function mapHttpError(status, path, body) {
  if (status === 401 || status === 403) {
    return new KarlancerApiError('unauthorized', 'Karlancer auth failed', { status, path, body });
  }
  if (status === 404) {
    return new KarlancerApiError('not_found', `Not found: ${path}`, { status, path, body });
  }
  if (status === 422) {
    return new KarlancerApiError('validation', 'Validation failed', { status, path, body });
  }
  if (status === 429) {
    return new KarlancerApiError('rate_limited', 'Rate limited', { status, path, body });
  }
  if (status >= 500) {
    return new KarlancerApiError('upstream_5xx', `Upstream ${status}`, { status, path, body });
  }
  return new KarlancerApiError('http_error', `HTTP ${status}`, { status, path, body });
}
