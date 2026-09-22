import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { createMcpServer } from '../../src/mcp/create-server.js';

test('MCP create succeeds with expanded API surface', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'mcp.sqlite'));
  const queue = createJobQueue(db);
  const api = createKarlancerApi({
    accessToken: 't',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"status":"success","data":{}}', headers: new Map() }),
  });
  assert.ok(api.notifications && api.bookmarks && api.search && api.plans && api.files);
  const server = createMcpServer({
    db,
    queue,
    api,
    stateDir: path.join(os.tmpdir(), 'state'),
    root: path.resolve('.'),
    startedAt: Date.now(),
    getScopes: () => ['admin'],
    getTenantId: () => 't1',
  });
  assert.equal(typeof server.registerTool, 'function');
});
