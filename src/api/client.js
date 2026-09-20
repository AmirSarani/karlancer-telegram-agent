/**
 * Typed HTTP client for karlancer.com — no browser, no Playwright.
 * Auth: KARLANCER_ACCESS_TOKEN (Bearer) and/or KARLANCER_COOKIE.
 */
import { assertAllowedUrl } from '../security/redaction.js';
import { mapHttpError, KarlancerApiError } from './errors.js';
import { logger } from '../observability/logger.js';

/**
 * @typedef {object} KarlancerClientOptions
 * @property {string} [baseUrl]
 * @property {string} [accessToken]
 * @property {string} [cookie]
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @property {typeof fetch} [fetchImpl]
 */

export class KarlancerClient {
  /** @param {KarlancerClientOptions} [opts] */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || 'https://www.karlancer.com').replace(/\/$/, '');
    assertAllowedUrl(this.baseUrl);
    this.accessToken = opts.accessToken || '';
    this.cookie = opts.cookie || '';
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
    this._circuitOpenUntil = 0;
    this._consecutiveFailures = 0;
  }

  get hasAuth() {
    return Boolean(this.accessToken || this.cookie);
  }

  _headers(extra = {}) {
    /** @type {Record<string,string>} */
    const h = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    };
    if (this.accessToken) {
      const t = this.accessToken.startsWith('Bearer ')
        ? this.accessToken
        : `Bearer ${this.accessToken}`;
      h.Authorization = t;
    }
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, auth?: boolean, retries?: number }} [opts]
   */
  async request(method, path, opts = {}) {
    if (Date.now() < this._circuitOpenUntil) {
      throw new KarlancerApiError('circuit_open', 'Circuit breaker open for Karlancer API');
    }
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (!path.startsWith('http')) assertAllowedUrl(this.baseUrl);

    const needsAuth = opts.auth !== false && !path.includes('/api/publics/');
    if (needsAuth && !this.hasAuth) {
      throw new KarlancerApiError('missing_auth', 'KARLANCER_ACCESS_TOKEN or KARLANCER_COOKIE required');
    }

    const retries = opts.retries ?? this.maxRetries;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        /** @type {RequestInit} */
        const init = {
          method,
          headers: this._headers(
            opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}
          ),
          signal: ctrl.signal,
        };
        if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

        const res = await this.fetchImpl(url, init);
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { raw: text?.slice(0, 500) };
        }

        if (res.status >= 500) {
          lastErr = mapHttpError(res.status, path, json);
          if (attempt < retries) {
            await sleep(400 * (attempt + 1) + Math.floor(Math.random() * 200));
            continue;
          }
          this._trip(lastErr);
          throw lastErr;
        }

        if (!res.ok) {
          const err = mapHttpError(res.status, path, json);
          if (res.status >= 500) this._trip(err);
          else this._consecutiveFailures = 0;
          throw err;
        }

        this._consecutiveFailures = 0;
        return { status: res.status, data: json, headers: res.headers };
      } catch (e) {
        if (e instanceof KarlancerApiError) throw e;
        lastErr = e.name === 'AbortError'
          ? new KarlancerApiError('timeout', `Timeout after ${this.timeoutMs}ms`, { path })
          : new KarlancerApiError('network', e.message || 'network error', { path });
        if (attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        this._trip(lastErr);
        throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  _trip(err) {
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= 5) {
      this._circuitOpenUntil = Date.now() + 30_000;
      logger.warn('karlancer_circuit_open', { until: this._circuitOpenUntil, err: err.code });
    }
  }

  get(path, opts) {
    return this.request('GET', path, opts);
  }

  post(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, body });
  }

  /**
   * Try multiple endpoint/payload pairs; first 2xx wins.
   * Used for unverified mutation contracts (bid / send message).
   */
  async tryPost(candidates, { label = 'tryPost' } = {}) {
    const attempts = [];
    let lastError = null;
    for (const c of candidates) {
      try {
        const res = await this.post(c.path, c.body, { retries: 0 });
        attempts.push({ path: c.path, status: res.status, ok: true, shape: c.shape });
        logger.info('tryPost_success', { label, path: c.path, shape: c.shape });
        return { ok: true, path: c.path, shape: c.shape, data: res.data, attempts };
      } catch (e) {
        const status = e.status;
        attempts.push({
          path: c.path,
          status,
          ok: false,
          shape: c.shape,
          code: e.code,
          error: e.message,
        });
        lastError = e;
        if (status === 401 || status === 403) {
          return { ok: false, error: e, attempts, blocked: 'unauthorized' };
        }
        if (status === 404) continue;
        // 422: try next payload shape on same or next path
        continue;
      }
    }
    return {
      ok: false,
      error: lastError || new KarlancerApiError('all_attempts_failed', `${label} failed`),
      attempts,
      blocked: 'unverified_contract',
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default KarlancerClient;
