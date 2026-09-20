import crypto from 'node:crypto';

/**
 * Simple API-key auth for MCP HTTP / admin REST.
 * Keys stored as sha256 hashes in env MCP_API_KEYS=hash1:scope1,scope2;hash2:scope3
 * Or plaintext for local only: MCP_API_KEY=devkey (hashed at load).
 */
export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

export function loadApiKeyRegistry(env = process.env) {
  /** @type {Map<string, {scopes: string[], label: string}>} */
  const map = new Map();
  if (env.MCP_API_KEY) {
    map.set(hashApiKey(env.MCP_API_KEY), {
      scopes: (env.MCP_API_SCOPES || 'read,write,admin').split(',').map((s) => s.trim()),
      label: 'env_MCP_API_KEY',
    });
  }
  const multi = env.MCP_API_KEYS || '';
  for (const part of multi.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [hash, scopes = 'read'] = part.split(':');
    if (hash) map.set(hash, { scopes: scopes.split(',').map((s) => s.trim()), label: 'registry' });
  }
  return map;
}

export function authorizeApiKey(registry, presentedKey, requiredScope = 'read') {
  if (!presentedKey) return { ok: false, code: 'missing_api_key' };
  const entry = registry.get(hashApiKey(presentedKey));
  if (!entry) return { ok: false, code: 'invalid_api_key' };
  if (requiredScope && !entry.scopes.includes(requiredScope) && !entry.scopes.includes('admin')) {
    return { ok: false, code: 'insufficient_scope', scopes: entry.scopes };
  }
  return { ok: true, scopes: entry.scopes, label: entry.label };
}

export function requireToolPermission(toolMeta, scopes) {
  const need = toolMeta.permission || 'read';
  if (need === 'public') return true;
  if (!scopes) return false;
  if (scopes.includes('admin')) return true;
  if (need === 'read') return scopes.includes('read') || scopes.includes('write');
  if (need === 'write') return scopes.includes('write');
  if (need === 'approve') return scopes.includes('approve') || scopes.includes('write') || scopes.includes('admin');
  return false;
}
