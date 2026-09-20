import crypto from 'node:crypto';

/**
 * API-key auth for MCP HTTP / admin REST.
 *
 * Multi-tenant model: each API key is bound to a tenantId.
 * - MCP_API_KEY=plaintext (optional MCP_API_SCOPES, MCP_API_KEY_TENANT)
 * - MCP_API_KEYS=sha256hash:scope1,scope2[:tenantId];...
 *
 * Tenant named `default` is NOT a wildcard/super-admin.
 * Cross-tenant access requires explicit scope `cross_tenant_admin` or `super_admin`.
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
  if (requiredScope && !entry.scopes.includes(requiredScope) && !entry.scopes.includes('admin') && !entry.scopes.includes('super_admin')) {
    return { ok: false, code: 'insufficient_scope', scopes: entry.scopes, tenantId: entry.tenantId };
  }
  return { ok: true, scopes: entry.scopes, label: entry.label, tenantId: entry.tenantId || 'default' };
}

export function requireToolPermission(toolMeta, scopes) {
  const need = toolMeta.permission || 'read';
  if (need === 'public') return true;
  if (!scopes) return false;
  if (scopes.includes('admin') || scopes.includes('super_admin')) return true;
  if (need === 'read') return scopes.includes('read') || scopes.includes('write');
  if (need === 'write') return scopes.includes('write');
  if (need === 'approve') return scopes.includes('approve') || scopes.includes('write') || scopes.includes('admin');
  return false;
}

/** Explicit cross-tenant scopes only — never implied by tenantId === 'default'. */
export function canAccessCrossTenant(scopes) {
  if (!Array.isArray(scopes)) return false;
  return scopes.includes('cross_tenant_admin') || scopes.includes('super_admin');
}

/**
 * Same-tenant always OK. Cross-tenant only with cross_tenant_admin | super_admin.
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function assertTenantAccess({ requesterTenantId, resourceTenantId, scopes }) {
  const req = requesterTenantId == null || requesterTenantId === '' ? 'default' : String(requesterTenantId);
  const res = resourceTenantId == null || resourceTenantId === '' ? 'default' : String(resourceTenantId);
  if (req === res) return { ok: true };
  if (canAccessCrossTenant(scopes)) return { ok: true };
  return { ok: false, code: 'forbidden' };
}

