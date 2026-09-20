/**
 * Karlancer credential model
 * ---------------------------
 * DEFAULT (current production path): SHARED process-level credential from env
 *   KARLANCER_ACCESS_TOKEN (+ optional KARLANCER_COOKIE).
 *   All tenants share the same Karlancer HTTP session when only env is set.
 *
 * OPTIONAL per-tenant path (minimum safe implementation):
 *   - Table tenant_credentials holds AES-256-GCM ciphertext (token/cookie).
 *   - Encryption key from KARLANCER_CREDENTIAL_KEK (32-byte base64) or
 *     derived from KARLANCER_CREDENTIAL_SECRET via scrypt.
 *   - Never log plaintext. Never commit secrets.
 *
 * Until operators provision per-tenant rows, resolveTenantKarlancerCredential
 * falls back to the shared env credential and records source: 'shared_env'.
 */
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

function getKek(env = process.env) {
  const b64 = env.KARLANCER_CREDENTIAL_KEK || env.KARLANCER_CREDENTIALS_KEK;
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 32) throw new Error('KARLANCER_CREDENTIAL_KEK must be 32-byte base64');
    return buf;
  }
  const secret = env.KARLANCER_CREDENTIAL_SECRET || env.KARLANCER_CREDENTIALS_SECRET;
  if (secret) {
    return crypto.scryptSync(String(secret), 'karlancer-tenant-cred-v1', 32);
  }
  return null;
}

export function encryptSecret(plaintext, env = process.env) {
  const kek = getKek(env);
  if (!kek) throw new Error('missing_credential_kek');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, kek, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(blobB64, env = process.env) {
  const kek = getKek(env);
  if (!kek) throw new Error('missing_credential_kek');
  const buf = Buffer.from(blobB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function ensureTenantCredentialsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_credentials (
      tenant_id TEXT PRIMARY KEY,
      token_ciphertext TEXT,
      cookie_ciphertext TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Store per-tenant Karlancer token/cookie (encrypted at rest).
 */
export function upsertTenantCredential(db, { tenantId, accessToken, cookie }, env = process.env) {
  if (!tenantId) throw new Error('tenantId_required');
  ensureTenantCredentialsTable(db);
  const now = new Date().toISOString();
  const tokenCt = accessToken != null ? encryptSecret(accessToken, env) : null;
  const cookieCt = cookie != null ? encryptSecret(cookie, env) : null;
  db.prepare(
    `INSERT INTO tenant_credentials (tenant_id, token_ciphertext, cookie_ciphertext, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       token_ciphertext = COALESCE(excluded.token_ciphertext, tenant_credentials.token_ciphertext),
       cookie_ciphertext = COALESCE(excluded.cookie_ciphertext, tenant_credentials.cookie_ciphertext),
       updated_at = excluded.updated_at`
  ).run(tenantId, tokenCt, cookieCt, now);
  return { tenantId, updatedAt: now };
}

/**
 * Resolve credential for a tenant.
 * @returns {{ accessToken: string|null, cookie: string|null, source: 'tenant_encrypted'|'shared_env'|'none' }}
 */
export function resolveTenantKarlancerCredential(db, tenantId, env = process.env) {
  ensureTenantCredentialsTable(db);
  try {
    const row = db.prepare(`SELECT * FROM tenant_credentials WHERE tenant_id = ?`).get(tenantId);
    if (row?.token_ciphertext) {
      return {
        accessToken: decryptSecret(row.token_ciphertext, env),
        cookie: row.cookie_ciphertext ? decryptSecret(row.cookie_ciphertext, env) : null,
        source: 'tenant_encrypted',
      };
    }
  } catch (e) {
    // Missing KEK or corrupt row → do not leak; fall through to shared
    if (e.message !== 'missing_credential_kek') {
      throw e;
    }
  }
  const shared = env.KARLANCER_ACCESS_TOKEN || '';
  if (shared) {
    return {
      accessToken: shared,
      cookie: env.KARLANCER_COOKIE || null,
      source: 'shared_env',
    };
  }
  return { accessToken: null, cookie: null, source: 'none' };
}
