/**
 * P0: tenant named `default` is NOT a wildcard. Cannot read/cancel/approve tenant-a.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { assertTenantAccess, canAccessCrossTenant } from '../../src/security/auth.js';
import { createMcpServer } from '../../src/mcp/create-server.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-def-')), 't.sqlite'));
}

test('assertTenantAccess: default cannot access tenant-a without cross_tenant_admin', () => {
  assert.equal(
    assertTenantAccess({
      requesterTenantId: 'default',
      resourceTenantId: 'tenant-a',
      scopes: ['read', 'write', 'admin'],
    }).ok,
    false
  );
  assert.equal(
    assertTenantAccess({
      requesterTenantId: 'default',
      resourceTenantId: 'tenant-a',
      scopes: ['cross_tenant_admin'],
    }).ok,
    true
  );
  assert.equal(canAccessCrossTenant(['admin']), false);
  assert.equal(canAccessCrossTenant(['super_admin']), true);
});

test('API key for default cannot job.get_status / job.cancel tenant-a', async () => {
  const db = tmpDb();
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
    getTenantId: () => 'default',
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await server.connect(st);
  await client.connect(ct);
  const status = await client.callTool({ name: 'job.get_status', arguments: { jobId: job.jobId } });
  assert.equal(status.isError, true);
  assert.ok(status.content[0].text.includes('forbidden') || status.content[0].text.includes('tenant'));
  const cancel = await client.callTool({ name: 'job.cancel', arguments: { jobId: job.jobId } });
  assert.equal(cancel.isError, true);
  await client.close();
});

test('default cannot approvals.get/decide tenant-a; list & audit.search stay scoped', async () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  queue.create({
    goal: 'bids.submit',
    tenantId: 'tenant-a',
    requiresApproval: true,
    payload: {
      projectId: 1,
      proposalText: 'hello world proposal text here',
      price: 1e7,
      days: 5,
    },
  });
  const appr = queue.pendingApprovals('tenant-a')[0];
  assert.ok(appr);

  db.prepare(
    `INSERT INTO audit_log (id, tenant_id, actor, action, tool, result_code, correlation_id, created_at)
     VALUES (?, 'tenant-a', 't', 'tool_call', 'x', 'ok', ?, ?)`
  ).run(crypto.randomUUID(), crypto.randomUUID(), new Date().toISOString());

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
    getScopes: () => ['admin', 'approve'],
    getTenantId: () => 'default',
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await server.connect(st);
  await client.connect(ct);

  const list = await client.callTool({ name: 'approvals.list', arguments: {} });
  const listed = JSON.parse(list.content[0].text);
  const pending = listed.pending || [];
  assert.ok(!pending.find((a) => a.approval_id === appr.approval_id));

  const get = await client.callTool({
    name: 'approvals.get',
    arguments: { approvalId: appr.approval_id },
  });
  assert.equal(get.isError, true);

  const decide = await client.callTool({
    name: 'approvals.decide',
    arguments: { approvalId: appr.approval_id, approve: true },
  });
  assert.equal(decide.isError, true);

  const audit = await client.callTool({ name: 'audit.search', arguments: { limit: 50 } });
  const auditBody = JSON.parse(audit.content[0].text);
  const rows = auditBody.rows || [];
  assert.ok(rows.every((r) => r.tenant_id === 'default'));
  await client.close();
});
