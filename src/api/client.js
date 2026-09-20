/**
 * Typed HTTP client for karlancer.com — no browser, no Playwright.
 * Auth: KARLANCER_ACCESS_TOKEN (Bearer) and/or KARLANCER_COOKIE.
 *
 * Reads may retry. Mutations (opts.mutation=true) NEVER auto-retry.
 * tryPost is discovery-only and MUST NOT be used for bid/chat production mutations.
 */
import { assertAllowedUrl } from '../security/redaction.js';
import { mapHttpError, KarlancerApiError } from './errors.js';
import { logger } from '../observability/logger.js';
import { RateLimiter } from './rate-limit.js';

/**
 * @typedef {object} KarlancerClientOptions
 * @property {string} [baseUrl]
 * @property {string} [accessToken]
 * @property {string} [cookie]
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @property {typeof fetch} [fetchImpl]
 * @property {RateLimiter} [rateLimiter]
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
    this.rateLimiter = opts.rateLimiter || new RateLimiter({ capacity: 30, refillPerSec: 8 });
    this._circuitOpenUntil = 0;
    this._consecutiveFailures = 0;
  }

  get hasAuth() {
    return Boolean(this.accessToken || this.cookie);
  }

  /** Hot-reload token without process restart (rotation). */
  setAccessToken(token) {
    this.accessToken = token || '';
  }

  setCookie(cookie) {
    this.cookie = cookie || '';
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
   * @param {{ body?: unknown, auth?: boolean, retries?: number, mutation?: boolean, operationId?: string }} [opts]
   */
  async request(method, path, opts = {}) {
    if (Date.now() < this._circuitOpenUntil) {
      throw new KarlancerApiError('circuit_open', 'Circuit breaker open for Karlancer API');
    }
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (!path.startsWith('http')) assertAllowedUrl(this.baseUrl);
    else assertAllowedUrl(url);

    const needsAuth = opts.auth !== false && !path.includes('/api/publics/');
    if (needsAuth && !this.hasAuth) {
      throw new KarlancerApiError('missing_auth', 'KARLANCER_ACCESS_TOKEN or KARLANCER_COOKIE required');
    }

    // Mutations: zero retries. Reads: configurable.
    const isMutation = opts.mutation === true || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
    const retries = isMutation ? 0 : (opts.retries ?? this.maxRetries);

    await this.rateLimiter.waitTake(1);

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
        if (opts.operationId) {
          init.headers = { ...init.headers, 'X-Idempotency-Key': opts.operationId };
        }

        const res = await this.fetchImpl(url, init);
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { raw: text?.slice(0, 200) };
        }

        if (res.status >= 500) {
          lastErr = mapHttpError(res.status, path, sanitizeBody(json));
          if (!isMutation && attempt < retries) {
            await sleep(backoffMs(attempt));
            continue;
          }
          this._trip(lastErr);
          throw lastErr;
        }

        if (res.status === 429) {
          lastErr = mapHttpError(429, path, sanitizeBody(json));
          if (!isMutation && attempt < retries) {
            await sleep(backoffMs(attempt) * 2);
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          const err = mapHttpError(res.status, path, sanitizeBody(json));
          this._consecutiveFailures = 0;
          throw err;
        }

        this._consecutiveFailures = 0;
        return { status: res.status, data: json, headers: res.headers, rawText: text };
      } catch (e) {
        if (e instanceof KarlancerApiError) throw e;
        lastErr =
          e.name === 'AbortError'
            ? new KarlancerApiError('timeout', `Timeout after ${this.timeoutMs}ms`, { path })
            : new KarlancerApiError('network', e.message || 'network error', { path });
        if (!isMutation && attempt < retries) {
          await sleep(backoffMs(attempt));
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
   * Discovery-only tryPost — FORBIDDEN for production bid/chat mutations.
   * Safe for optional read-ish discovery (e.g. profile GET try-list uses GET, not this).
   * @deprecated Do not use for bids.submit or messages.send.
   */
  async tryPost(candidates, { label = 'tryPost', allowMutationDiscovery = false } = {}) {
    if (!allowMutationDiscovery) {
      throw new KarlancerApiError(
        'tryPost_forbidden',
        `tryPost blocked for production mutations (label=${label}). Use VerifiedMutationContract.`
      );
    }
    const attempts = [];
    let lastError = null;
    for (const c of candidates) {
      try {
        const res = await this.post(c.path, c.body, { retries: 0, mutation: true });
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

function backoffMs(attempt) {
  return 400 * 2 ** attempt + Math.floor(Math.random() * 200);
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  // Never echo potential secrets from upstream into errors
  const clone = { ...body };
  for (const k of Object.keys(clone)) {
    if (/token|auth|cookie|password|secret/i.test(k)) clone[k] = '[REDACTED]';
  }
  return clone;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default KarlancerClient;
