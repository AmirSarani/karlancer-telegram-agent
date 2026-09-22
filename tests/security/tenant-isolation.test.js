/**
 * Multi-tenant isolation: API key → tenantId binding; cross-tenant denied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { loadApiKeyRegistry, authorizeApiKey, hashApiKey } from '../../src/security/auth.js';
import { createMcpServer } from '../../src/mcp/create-server.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('API key binds to tenantId', () => {
  const keyA = 'secret-a';
  const keyB = 'secret-b';
  const reg = loadApiKeyRegistry({
    MCP_API_KEYS: `${hashApiKey(keyA)}:read,write:tenant-a;${hashApiKey(keyB)}:read,write:tenant-b`,
  });
  const a = authorizeApiKey(reg, keyA, 'read');
  const b = authorizeApiKey(reg, keyB, 'read');
  assert.equal(a.ok, true);
  assert.equal(a.tenantId, 'tenant-a');
  assert.equal(b.tenantId, 'tenant-b');
});

test('job.get_status cross-tenant → forbidden', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-ten-')), 't.sqlite'));
  const queue = createJobQueue(db);
  const job = queue.create({ goal: 'health.ping', tenantId: 'tenant-a' });
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  const server = createMcpServer({
    db,
    queue,
    api,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')),
    root: path.resolve('.'),
    startedAt: Date.now(),
    getScopes: () => ['admin'],
    getTenantId: () => 'tenant-b',
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await server.connect(st);
  await client.connect(ct);
  const res = await client.callTool({ name: 'job.get_status', arguments: { jobId: job.jobId } });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('forbidden') || res.content[0].text.includes('tenant'));
  await client.close();
});

test('queue.list tenant filter hides other tenants', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-ten2-')), 't.sqlite'));
  const queue = createJobQueue(db);
  const a = queue.create({ goal: 'health.ping', tenantId: 'tenant-a' });
  queue.create({ goal: 'health.ping', tenantId: 'tenant-b' });
  const listed = queue.list({ tenantId: 'tenant-b', status: 'queued' });
  assert.ok(!listed.find((j) => j.jobId === a.jobId));
  assert.ok(listed.every((j) => j.tenantId === 'tenant-b'));
});
