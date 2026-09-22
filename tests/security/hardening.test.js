import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertAllowedUrl, redactDeep } from '../../src/security/redaction.js';
import { loadApiKeyRegistry, authorizeApiKey, hashApiKey, requireToolPermission } from '../../src/security/auth.js';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { memorySearch, memoryAppend } from '../../src/memory/store.js';
import { KarlancerClient } from '../../src/api/client.js';

test('SSRF blocks arbitrary hosts', () => {
  assert.throws(() => assertAllowedUrl('https://evil.example/api'), /host_not_allowed/);
  assert.throws(() => assertAllowedUrl('http://www.karlancer.com'), /https_required/);
  assertAllowedUrl('https://www.karlancer.com');
});

test('secret leakage redaction', () => {
  const o = redactDeep({
    Authorization: 'Bearer SECRETTOKEN',
    nested: { access_token: 'abc', note: 'Bearer xyz.abc.def' },
  });
  assert.equal(o.Authorization, '[REDACTED]');
  assert.equal(o.nested.access_token, '[REDACTED]');
  assert.match(o.nested.note, /REDACTED/);
});

test('API key scope bypass blocked', () => {
  const reg = loadApiKeyRegistry({ MCP_API_KEY: 'readkey', MCP_API_SCOPES: 'read' });
  const ok = authorizeApiKey(reg, 'readkey', 'write');
  assert.equal(ok.ok, false);
  assert.equal(ok.code, 'insufficient_scope');
  assert.equal(requireToolPermission({ permission: 'approve' }, ['read']), false);
});

test('tenant data isolation on job lookup', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 't.sqlite'));
  const queue = createJobQueue(db);
  const job = queue.create({ goal: 'health.ping', tenantId: 'tenant-a' });
  const listed = queue.list({ tenantId: 'tenant-b', status: 'queued' });
  assert.ok(!listed.find((j) => j.jobId === job.jobId));
});

test('memory search escapes LIKE metacharacters / parameterized', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'm.sqlite'));
  memoryAppend(db, { kind: 'note', content: '100%_done' });
  const hits = memorySearch(db, { q: '100%_done' });
  assert.equal(hits.length, 1);
  // injection-ish input should not throw
  assert.doesNotThrow(() => memorySearch(db, { q: "'; DROP TABLE memory_items;--" }));
});

test('client refuses non-karlancer absolute URL', async () => {
  const c = new KarlancerClient({ accessToken: 't', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  await assert.rejects(() => c.get('https://evil.example/x'), /host_not_allowed/);
});

test('Telegram owner spoofing: isOwner requires exact chat id', async () => {
  const { isOwnerContext } = await import('../../src/telegram/bot.js');
  const owners = [111];
  assert.equal(isOwnerContext({ chat: { id: 222 }, from: { id: 222 } }, owners), false);
  assert.equal(isOwnerContext({ chat: { id: 111 }, from: { id: 999 } }, owners), true);
  assert.equal(isOwnerContext({ chat: { id: 222 }, from: { id: 222 } }, [111, 333]), false);
  assert.equal(isOwnerContext({ chat: { id: 333 }, from: { id: 333 } }, [111, 333]), true);
});

test('replay approval after decide fails soft', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'r.sqlite'));
  const queue = createJobQueue(db);
  const job = queue.create({
    goal: 'messages.send',
    requiresApproval: true,
    payload: { roomId: 1, text: 'hi' },
  });
  const id = queue.getApprovalForJob(job.jobId).approval_id;
  queue.decideApproval(id, { approve: true, decidedBy: 'a' });
  const again = queue.decideApproval(id, { approve: true, decidedBy: 'a' });
  assert.equal(again.alreadyDecided, true);
});

test('hashApiKey stable', () => {
  assert.equal(hashApiKey('abc'), hashApiKey('abc'));
  assert.notEqual(hashApiKey('abc'), hashApiKey('abd'));
});
