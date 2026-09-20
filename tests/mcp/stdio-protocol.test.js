/**
 * MCP stdio protocol smoke: initialize via in-process transport if available,
 * otherwise verify createMcpServer + tool registration path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { createMcpServer } from '../../src/mcp/create-server.js';

test('MCP in-memory: initialize, tools/list, tools/call health.get', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'stdio.sqlite'));
  const queue = createJobQueue(db);
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
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  for (const required of [
    'health.get',
    'project.get',
    'rooms.list',
    'room.messages',
    'bids.check',
    'memory.search',
    'job.get_status',
    'pricing.get_recommendation',
    'intelligence.get_insight',
    'bids.submit_plan',
    'messages.send_plan',
    'project.analyze_plan',
    'proposal.draft_plan',
    'approvals.list',
    'approvals.get',
    'approvals.decide',
    'job.cancel',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }

  const result = await client.callTool({ name: 'health.get', arguments: { detailed: false } });
  assert.ok(result.content?.[0]?.text);
  const body = JSON.parse(result.content[0].text);
  assert.ok(body.status || body.ts);

  // insufficient scope
  const server2 = createMcpServer({
    db,
    queue,
    api,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')),
    root: path.resolve('.'),
    startedAt: Date.now(),
    getScopes: () => ['read'],
  });
  const [c2t, s2t] = InMemoryTransport.createLinkedPair();
  const client2 = new Client({ name: 'test2', version: '1.0.0' });
  await server2.connect(s2t);
  await client2.connect(c2t);
  const denied = await client2.callTool({
    name: 'bids.submit_plan',
    arguments: { projectId: 1, proposalText: 'hello world proposal', price: 1, days: 1 },
  });
  assert.equal(denied.isError, true);

  await client.close();
  await client2.close();
});
