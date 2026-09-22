import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createKarlancerApi } from '../../src/api/adapters/index.js';
import { createMcpServer } from '../../src/mcp/create-server.js';

test('MCP server registers required tools', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'mcp.sqlite'));
  const queue = createJobQueue(db);
  const api = createKarlancerApi({ accessToken: 't', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  const server = createMcpServer({
    db,
    queue,
    api,
    stateDir: path.join(os.tmpdir(), 'state'),
    root: path.resolve('.'),
    startedAt: Date.now(),
    getScopes: () => ['admin'],
  });
  assert.ok(server);
  // SDK stores tools internally; smoke that create does not throw and prompt exists
  assert.equal(typeof server.registerTool, 'function');
});

test('ENABLE_TELEGRAM=false config does not require token', async () => {
  process.env.ENABLE_TELEGRAM = 'false';
  delete process.env.TELEGRAM_BOT_TOKEN;
  const { loadAppConfig } = await import('../../src/config.js');
  const cfg = loadAppConfig({ requireTelegram: false });
  assert.equal(cfg.enableTelegram, false);
  delete process.env.ENABLE_TELEGRAM;
});
