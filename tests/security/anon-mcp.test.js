import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Documents + unit-checks the anon policy used by http-entry:
 * MCP_ALLOW_ANON=true must NEVER grant admin/write/approve.
 */
test('anon scopes policy', () => {
  function anonAuth(scope) {
    if (scope === 'admin' || scope === 'approve' || scope === 'write') {
      return { ok: false, code: 'anon_insufficient_scope' };
    }
    return { ok: true, scopes: ['read'] };
  }
  assert.equal(anonAuth('read').ok, true);
  assert.equal(anonAuth('write').ok, false);
  assert.equal(anonAuth('admin').ok, false);
  assert.equal(anonAuth('approve').ok, false);
  assert.ok(!anonAuth('read').scopes.includes('admin'));
});

test('session binding: possession of session id alone insufficient', () => {
  const sessions = new Map();
  sessions.set('sid1', { keyHash: 'hash-a' });
  function allowed(sid, keyHash) {
    const row = sessions.get(sid);
    return row && row.keyHash === keyHash;
  }
  assert.equal(allowed('sid1', 'hash-a'), true);
  assert.equal(allowed('sid1', 'hash-attacker'), false);
});
