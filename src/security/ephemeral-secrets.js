/**
 * AES-256-GCM for ephemeral re-login secrets (phone/password in memory only).
 *
 * Key resolution (first match):
 * 1. TELEGRAM_SECRETS_KEY — 64 hex chars (32 bytes) or standard base64 of 32 bytes
 * 2. Derived via scrypt from TELEGRAM_BOT_TOKEN | KARLANCER_CREDENTIAL_SECRET | MCP_API_KEY
 *
 * Ciphertext only in Map state; plaintext wiped after use. Never log plaintext.
 * Generate on VPS: openssl rand -hex 32  → write to .env (chmod 600), never print.
 */
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const SCRYPT_SALT = 'karlancer-telegram-ephemeral-v1';
const PREFIX = 'eg1:'; // versioned blob marker

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Buffer}
 */
export function resolveTelegramSecretsKey(env = process.env) {
  const raw = env.TELEGRAM_SECRETS_KEY;
  if (raw && String(raw).trim()) {
    const s = String(raw).trim();
    if (/^[0-9a-fA-F]{64}$/.test(s)) {
      return Buffer.from(s, 'hex');
    }
    try {
      const buf = Buffer.from(s, 'base64');
      if (buf.length === 32) return buf;
    } catch {
      /* fall through */
    }
    throw new Error('TELEGRAM_SECRETS_KEY must be 64 hex chars or 32-byte base64');
  }
  const material =
    env.TELEGRAM_BOT_TOKEN ||
    env.KARLANCER_CREDENTIAL_SECRET ||
    env.KARLANCER_CREDENTIALS_SECRET ||
    env.MCP_API_KEY;
  if (material && String(material).trim()) {
    return crypto.scryptSync(String(material), SCRYPT_SALT, 32);
  }
  throw new Error('missing_telegram_secrets_key');
}

/**
 * @param {string} plaintext
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} versioned base64 blob (safe to keep in memory Map)
 */
export function encryptEphemeral(plaintext, env = process.env) {
  const key = resolveTelegramSecretsKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * @param {string} blob
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function decryptEphemeral(blob, env = process.env) {
  if (blob == null || blob === '') throw new Error('empty_ephemeral_blob');
  const s = String(blob);
  if (!s.startsWith(PREFIX)) throw new Error('invalid_ephemeral_blob');
  const key = resolveTelegramSecretsKey(env);
  const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
  if (buf.length < 28) throw new Error('invalid_ephemeral_blob');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Best-effort clear of a mutable holder (JS strings are immutable; clear refs).
 * @param {{ value?: string|null }} holder
 */
export function wipeHolder(holder) {
  if (holder && typeof holder === 'object') {
    holder.value = '';
    holder.value = null;
  }
}

export default {
  encryptEphemeral,
  decryptEphemeral,
  resolveTelegramSecretsKey,
  wipeHolder,
};
