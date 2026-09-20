import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../src/mcp/create-server.js';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';

test('MCP server registers expected tools', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-'));
  const db = openDb(path.join(dir, 'm.sqlite'));
  const queue = createJobQueue(db);
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}', headers: new Map() }),
  });
  const mcp = createMcpServer({
    db,
    queue,
    api,
    stateDir: dir,
    root: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
    startedAt: Date.now(),
    getScopes: () => ['admin'],
  });
  assert.ok(mcp instanceof McpServer);
  // Internal registered tools map
  const tools = mcp._registeredTools || {};
  const names = Object.keys(tools);
  for (const n of [
    'health.get',
    'project.get',
    'job.create',
    'job.get_status',
    'bids.submit_plan',
    'memory.search',
    'pricing.get_recommendation',
    'approvals.decide',
  ]) {
    assert.ok(names.includes(n), `missing tool ${n}, have ${names.join(',')}`);
  }
});

test('job.create health.ping via queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-'));
  const db = openDb(path.join(dir, 'm2.sqlite'));
  const queue = createJobQueue(db);
  const job = queue.create({ goal: 'health.ping', requestedBy: 'test' });
  assert.equal(job.status, 'queued');
  assert.ok(job.jobId);
});
