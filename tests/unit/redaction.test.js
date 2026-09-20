import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactDeep, assertAllowedUrl } from '../../src/security/redaction.js';
import { hashApiKey, authorizeApiKey, loadApiKeyRegistry } from '../../src/security/auth.js';

test('redacts tokens', () => {
  const out = redactDeep({ Authorization: 'Bearer secret', nested: { access_token: 'x' } });
  assert.equal(out.Authorization, '[REDACTED]');
  assert.equal(out.nested.access_token, '[REDACTED]');
});

test('SSRF host guard', () => {
  assert.throws(() => assertAllowedUrl('https://evil.com'), /host_not_allowed/);
  assert.throws(() => assertAllowedUrl('http://www.karlancer.com'), /https_required/);
  assertAllowedUrl('https://www.karlancer.com');
});

test('api key scopes', () => {
  const key = 'dev-secret';
  const reg = loadApiKeyRegistry({ MCP_API_KEY: key, MCP_API_SCOPES: 'read' });
  assert.equal(authorizeApiKey(reg, key, 'read').ok, true);
  assert.equal(authorizeApiKey(reg, key, 'write').ok, false);
  assert.equal(authorizeApiKey(reg, 'wrong', 'read').ok, false);
  assert.equal(hashApiKey(key).length, 64);
});
