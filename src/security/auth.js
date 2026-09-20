import crypto from 'node:crypto';

/**
 * API-key auth for MCP HTTP / admin REST.
 *
 * Multi-tenant model: each API key is bound to a tenantId.
 * - MCP_API_KEY=plaintext (optional MCP_API_SCOPES, MCP_API_KEY_TENANT)
 * - MCP_API_KEYS=sha256hash:scope1,scope2[:tenantId];...
 *
 * Cross-tenant data access must be denied by callers using entry.tenantId.
 */
export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

export function loadApiKeyRegistry(env = process.env) {
  /** @type {Map<string, {scopes: string[], label: string, tenantId: string}>} */
  const map = new Map();
  if (env.MCP_API_KEY) {
    map.set(hashApiKey(env.MCP_API_KEY), {
      scopes: (env.MCP_API_SCOPES || 'read,write,admin').split(',').map((s) => s.trim()),
      label: 'env_MCP_API_KEY',
      tenantId: (env.MCP_API_KEY_TENANT || 'default').trim() || 'default',
    });
  }
  const multi = env.MCP_API_KEYS || '';
  for (const part of multi.split(';').map((s) => s.trim()).filter(Boolean)) {
    // hash:scopes or hash:scopes:tenantId
    const bits = part.split(':');
    const hash = bits[0];
    const scopes = (bits[1] || 'read').split(',').map((s) => s.trim()).filter(Boolean);
    const tenantId = (bits[2] || 'default').trim() || 'default';
    if (hash) map.set(hash, { scopes, label: 'registry', tenantId });
  }
  return map;
}

export function authorizeApiKey(registry, presentedKey, requiredScope = 'read') {
  if (!presentedKey) return { ok: false, code: 'missing_api_key' };
  const entry = registry.get(hashApiKey(presentedKey));
  if (!entry) return { ok: false, code: 'invalid_api_key' };
  if (requiredScope && !entry.scopes.includes(requiredScope) && !entry.scopes.includes('admin')) {
    return { ok: false, code: 'insufficient_scope', scopes: entry.scopes, tenantId: entry.tenantId };
  }
  return { ok: true, scopes: entry.scopes, label: entry.label, tenantId: entry.tenantId || 'default' };
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
