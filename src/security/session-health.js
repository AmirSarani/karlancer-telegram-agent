/**
 * Periodic Karlancer session health via GET /api/profile (or dashboard fallback).
 * On 401 notify all owners with renew CTA; never print secrets.
 */
import { checkTokenHealth, formatTokenWarningFa } from './token-health.js';
import { logger } from '../observability/logger.js';

export const DEFAULT_SESSION_HEALTH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * @param {object} deps
 * @param {{ user?: { me?: Function, dashboard?: Function }, client?: { hasAuth?: boolean, get?: Function } }} deps.api
 * @param {(text: string, meta?: object) => Promise<void>|void} deps.notifyAllOwners
 * @param {string} [deps.envFile]
 * @param {number} [deps.intervalMs]
 * @param {number} [deps.warnDays]
 * @param {() => boolean} [deps.isPaused]
 */
export function createSessionHealthMonitor(deps) {
  const {
    api,
    notifyAllOwners,
    envFile = null,
    intervalMs = DEFAULT_SESSION_HEALTH_INTERVAL_MS,
    warnDays,
    isPaused = () => false,
  } = deps;

  let timer = null;
  /** @type {{ ok: boolean|null, status: number|null, checkedAt: string|null, reason: string|null, ageWarn: boolean }} */
  let last = {
    ok: null,
    status: null,
    checkedAt: null,
    reason: null,
    ageWarn: false,
  };
  let last401NotifyAt = 0;
  const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

  /**
   * Probe /api/profile then dashboard/me. Never logs token.
   * @returns {Promise<typeof last>}
   */
  async function probe() {
    const checkedAt = new Date().toISOString();
    if (!api?.client?.hasAuth && !api?.user) {
      last = { ok: false, status: null, checkedAt, reason: 'no_auth', ageWarn: false };
      return last;
    }

    let status = null;
    let ok = false;
    let reason = null;

    try {
      if (typeof api?.client?.get === 'function') {
        try {
          const res = await api.client.get('/api/profile', { retries: 0 });
          status = res?.status ?? 200;
          ok = status >= 200 && status < 300;
        } catch (e) {
          status = e?.status ?? null;
          if (status === 401 || status === 403 || e?.code === 'unauthorized') {
            ok = false;
            reason = 'auth_401';
          } else {
            // Soft: try dashboard/me
            throw e;
          }
        }
      }
      if (!ok && reason !== 'auth_401' && typeof api?.user?.me === 'function') {
        const me = await api.user.me();
        if (me?.id || me?.status === 'ok' || me?.source === 'har_dashboard') {
          ok = true;
          status = status ?? 200;
          reason = null;
        } else if (me?.status === 'blocked_by_missing_api') {
          ok = api.client?.hasAuth ? null : false;
          reason = 'endpoint_uncertain';
        }
      }
    } catch (e) {
      status = e?.status ?? status;
      if (status === 401 || status === 403 || e?.code === 'unauthorized') {
        ok = false;
        reason = 'auth_401';
      } else {
        ok = last.ok;
        reason = 'probe_error';
        logger.warn('session_health_probe_failed', {
          status: status || null,
          code: e?.code || null,
        });
      }
    }

    const th = checkTokenHealth({
      authOk: ok === true ? true : ok === false ? false : null,
      got401: reason === 'auth_401',
      envFile,
      warnDays,
    });

    last = {
      ok,
      status,
      checkedAt,
      reason: reason || (th.warn ? th.reason : null),
      ageWarn: Boolean(th.warn && th.reason === 'token_age'),
      tokenHealth: th,
    };
    return last;
  }

  async function maybeNotify401() {
    if (last.reason !== 'auth_401' && last.ok !== false) return false;
    if (last.reason !== 'auth_401' && last.ok === false && last.reason === 'no_auth') {
      /* also notify missing auth once per cooldown */
    } else if (last.reason !== 'auth_401') {
      return false;
    }
    const now = Date.now();
    if (last401NotifyAt && now - last401NotifyAt < NOTIFY_COOLDOWN_MS) return false;
    last401NotifyAt = now;
    const text = [
      '⚠️ نشست کارلنسر منقضی شده (بررسی دوره‌ای /api/profile).',
      '',
      'از تنظیمات «🔐 تمدید نشست» را بزنید.',
      'ترجیح: چسباندن توکن مرورگر (بدون رمز در چت).',
      'رمز عبور فقط در صورت نبود توکن — و بعد پیام را پاک کنید.',
    ].join('\n');
    if (typeof notifyAllOwners === 'function') {
      await notifyAllOwners(text, { kind: 'session_401' });
    }
    return true;
  }

  async function tick() {
    if (isPaused()) return { skipped: true, reason: 'paused' };
    await probe();
    if (last.reason === 'auth_401' || (last.ok === false && last.reason === 'no_auth')) {
      await maybeNotify401();
    }
    return { skipped: false, last };
  }

  function getLast() {
    return { ...last };
  }

  function formatSettingsExtraFa() {
    const th = last.tokenHealth || checkTokenHealth({ envFile, authOk: last.ok });
    const lines = [];
    if (last.checkedAt) {
      lines.push(`• آخرین بررسی نشست: ${last.checkedAt.replace('T', ' ').slice(0, 16)} UTC`);
    }
    if (last.ok === true) lines.push('• سلامت نشست: ✅');
    else if (last.ok === false) lines.push('• سلامت نشست: ❌ نیاز به تمدید');
    if (th.ageDays != null) {
      lines.push(`• سن تقریبی توکن: ${Math.floor(th.ageDays)} روز`);
    }
    const warn = formatTokenWarningFa(th);
    if (warn) lines.push(`⚠️ ${warn}`);
    return lines.length ? lines.join('\n') : null;
  }

  return {
    probe,
    tick,
    getLast,
    formatSettingsExtraFa,
    start(ms = intervalMs) {
      timer = setInterval(() => {
        tick().catch(() => {});
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
      tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    _resetForTests() {
      last401NotifyAt = 0;
      last = { ok: null, status: null, checkedAt: null, reason: null, ageWarn: false };
    },
  };
}

export default createSessionHealthMonitor;
