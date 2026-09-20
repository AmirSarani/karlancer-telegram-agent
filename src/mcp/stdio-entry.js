import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadAppConfig } from '../config.js';
import { openDb } from '../memory/db.js';
import { createJobQueue } from '../worker/queue.js';
import { createKarlancerApi } from '../api/adapters/index.js';
import { createMcpServer } from './create-server.js';

const config = loadAppConfig({ requireTelegram: false });
const db = openDb(config.dbPath);
const queue = createJobQueue(db);
const api = createKarlancerApi({
  baseUrl: config.karlancerBaseUrl,
  accessToken: config.karlancerAccessToken,
  cookie: config.karlancerCookie,
  timeoutMs: config.karlancerTimeoutMs,
});

const mcp = createMcpServer({
  db,
  queue,
  api,
  stateDir: config.stateDir,
  root: config.root,
  startedAt: Date.now(),
  getScopes: () => ['admin'],
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
