/**
 * Persist KARLANCER_ACCESS_TOKEN to process env + .env (Sanctum id|secret safe).
 * Same rules as deploy/scripts/install-karlancer-token.sh:
 * - never bash-source the value
 * - never print the token
 * - write KEY=value with chmod 600 (value may contain `|`)
 */
import fs from 'node:fs';
import path from 'node:path';

export const ACCESS_TOKEN_ENV_KEY = 'KARLANCER_ACCESS_TOKEN';

/**
 * @param {string} token
 * @param {{ envFile?: string, client?: { setAccessToken?: Function }, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: boolean, envFile?: string, error?: string }}
 */
export function persistAccessToken(token, opts = {}) {
  const raw = String(token || '').replace(/\r/g, '').split('\n')[0].trim();
  if (!raw) return { ok: false, error: 'empty_token' };
  if (/\s/.test(raw)) return { ok: false, error: 'token_whitespace' };

  const env = opts.env || process.env;
  env[ACCESS_TOKEN_ENV_KEY] = raw;

  if (opts.client && typeof opts.client.setAccessToken === 'function') {
    opts.client.setAccessToken(raw);
  }

  const envFile = opts.envFile || env.ENV_FILE || path.resolve(process.cwd(), '.env');

  try {
    writeEnvKey(envFile, ACCESS_TOKEN_ENV_KEY, raw);
    return { ok: true, envFile };
  } catch (e) {
    return {
      ok: false,
      envFile,
      error: e?.code === 'EACCES' ? 'env_write_denied' : 'env_write_failed',
    };
  }
}

/**
 * @param {string} envFile
 * @param {string} key
 * @param {string} value
 */
export function writeEnvKey(envFile, key, value) {
  const dir = path.dirname(envFile);
  fs.mkdirSync(dir, { recursive: true });

  let lines = [];
  if (fs.existsSync(envFile)) {
    lines = fs.readFileSync(envFile, 'utf8').split(/\n/);
  }

  const keyRe = new RegExp(`^${escapeRegExp(key)}=`);
  const kept = lines.filter((ln) => !keyRe.test(ln));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  kept.push(`${key}=${value}`);
  const body = `${kept.join('\n')}\n`;

  const tmp = path.join(
    dir,
    `.env.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, body, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, envFile);
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    /* ignore */
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text
 * @param {string[]} secrets
 */
export function looksLikeSecretLeak(text, secrets = []) {
  const s = String(text || '');
  for (const sec of secrets) {
    if (sec && s.includes(sec)) return true;
  }
  return false;
}

export default persistAccessToken;
