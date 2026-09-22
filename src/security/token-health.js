/**
 * Sanctum / Karlancer access-token age & 401 health warnings for owners.
 * Cannot rotate password / bot token / root for the user — only warn + reauth deep-link UX.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Default: warn when token file / env mtime older than N days */
export const DEFAULT_TOKEN_WARN_DAYS = 14;

/**
 * @param {object} opts
 * @param {boolean|null} [opts.authOk] — last known hasAuth / probe
 * @param {boolean} [opts.got401]
 * @param {string} [opts.envFile] — path to .env (mtime used as proxy for token age)
 * @param {string} [opts.tokenFile] — optional dedicated token file
 * @param {number} [opts.warnDays]
 * @returns {{
 *   healthy: boolean|null,
 *   warn: boolean,
 *   reason: string|null,
 *   reasonFa: string|null,
 *   ageDays: number|null,
 *   mtime: string|null,
 * }}
 */
export function checkTokenHealth(opts = {}) {
  const warnDays = Number(opts.warnDays) > 0 ? Number(opts.warnDays) : DEFAULT_TOKEN_WARN_DAYS;
  if (opts.got401 || opts.authOk === false) {
    return {
      healthy: false,
      warn: true,
      reason: 'auth_401_or_false',
      reasonFa: 'نشست کارلنسر منقضی یا نامعتبر است (401). از تنظیمات «🔐 تمدید نشست» را بزنید.',
      ageDays: null,
      mtime: null,
    };
  }

  const candidates = [opts.tokenFile, opts.envFile].filter(Boolean);
  let mtimeMs = null;
  let used = null;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (mtimeMs == null || st.mtimeMs > mtimeMs) {
        mtimeMs = st.mtimeMs;
        used = p;
      }
    } catch {
      /* missing file ok */
    }
  }

  if (mtimeMs == null) {
    return {
      healthy: opts.authOk === true ? true : null,
      warn: false,
      reason: null,
      reasonFa: null,
      ageDays: null,
      mtime: null,
    };
  }

  const ageDays = (Date.now() - mtimeMs) / (24 * 60 * 60_000);
  const mtime = new Date(mtimeMs).toISOString();
  if (ageDays >= warnDays) {
    return {
      healthy: opts.authOk === true ? true : null,
      warn: true,
      reason: 'token_age',
      reasonFa: `توکن/نشست حدود ${Math.floor(ageDays)} روز از آخرین به‌روزرسانی می‌گذرد (آستانه ${warnDays} روز). بهتر است تمدید کنید — رمز را در چت نگذارید.`,
      ageDays,
      mtime,
      path: used ? path.basename(used) : null,
    };
  }

  return {
    healthy: opts.authOk === true ? true : null,
    warn: false,
    reason: null,
    reasonFa: null,
    ageDays,
    mtime,
  };
}

/**
 * Short Persian line for settings / digest / dashboard.
 */
export function formatTokenWarningFa(health) {
  if (!health?.warn) return null;
  return health.reasonFa || 'هشدار نشست کارلنسر';
}

export default { checkTokenHealth, formatTokenWarningFa, DEFAULT_TOKEN_WARN_DAYS };
