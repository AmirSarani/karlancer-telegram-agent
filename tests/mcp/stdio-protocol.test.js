/**
 * MCP stdio/in-memory protocol coverage.
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

async function linkedClient(ctx) {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test('MCP in-memory: initialize, tools/list, resources/list, resources/read, prompts/list, tools/call', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'stdio.sqlite'));
  const queue = createJobQueue(db);
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(stateDir, 'AGENT_HANDOFF.md'), '# handoff ok\n');
  const { client } = await linkedClient({
    db,
    queue,
    api,
    stateDir,
    root: path.resolve('.'),
    startedAt: Date.now(),
    getScopes: () => ['admin'],
  });

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  for (const required of [
    'health.get',
    'rooms.list',
    'project.get',
    'room.messages',
    'bids.check',
    'bids.submit_plan',
    'messages.send_plan',
    'project.analyze_plan',
    'proposal.draft_plan',
    'job.get_status',
    'job.cancel',
    'memory.search',
    'pricing.get_recommendation',
    'approvals.list',
    'approvals.get',
    'approvals.decide',
    'intelligence.get_insight',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}; have: ${names.join(',')}`);
  }

  const resources = await client.listResources();
  const uris = resources.resources.map((r) => r.uri);
  assert.ok(uris.includes('karlancer://handoff'), `uris=${uris}`);
  assert.ok(uris.includes('karlancer://project-state'), `uris=${uris}`);

  const read = await client.readResource({ uri: 'karlancer://handoff' });
  assert.ok(read.contents?.[0]?.text?.includes('handoff ok'));

  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((p) => p.name === 'karlancer_analyze'));

  const result = await client.callTool({ name: 'health.get', arguments: {} });
  assert.ok(result.content?.[0]?.text);
  const body = JSON.parse(result.content[0].text);
  assert.ok(body.status || body.ts);

  await client.close();
});

test('MCP in-memory: insufficient scope denied on write tool', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'stdio2.sqlite'));
  const queue = createJobQueue(db);
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  const { client } = await linkedClient({
    db,
    queue,
    api,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')),
    root: path.resolve('.'),
    startedAt: Date.now(),
    getScopes: () => ['read'],
  });
  const denied = await client.callTool({
    name: 'bids.submit_plan',
    arguments: { projectId: 1, proposalText: 'hello world proposal', price: 1, days: 1 },
  });
  assert.equal(denied.isError, true);
  await client.close();
});
