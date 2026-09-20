import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadAppConfig } from '../config.js';
import { openDb } from '../memory/db.js';
import { createJobQueue } from '../worker/queue.js';
import { createKarlancerApi } from '../api/adapters/index.js';
import { createMcpServer } from './create-server.js';
import { createLlmProvider, recordTokenUsage } from '../llm/provider.js';
import { TokenBudgetManager } from '../intelligence/token-budget.js';

const config = loadAppConfig({ requireTelegram: false });
const db = openDb(config.dbPath);
const queue = createJobQueue(db);
const api = createKarlancerApi({
  baseUrl: config.karlancerBaseUrl,
  accessToken: config.karlancerAccessToken,
  cookie: config.karlancerCookie,
  timeoutMs: config.karlancerTimeoutMs,
});
const budget = new TokenBudgetManager({
  dailyTokenLimit: config.dailyTokenLimit,
  getUsage: () => {
    const day = new Date().toISOString().slice(0, 10);
    const row = db.prepare(`SELECT tokens FROM token_usage WHERE tenant_id = 'default' AND day = ?`).get(day);
    return { tokens: row?.tokens || 0 };
  },
});
const llm = createLlmProvider({
  apiKey: config.openaiApiKey,
  baseUrl: config.openaiBaseUrl,
  smallModel: config.openaiModel,
  largeModel: config.openaiLargeModel || config.openaiModel,
  onUsage: (u) => recordTokenUsage(db, u),
});

const mcp = createMcpServer({
  db,
  queue,
  api,
  llm,
  budget,
  stateDir: config.stateDir,
  root: config.root,
  startedAt: Date.now(),
  getScopes: () => ['admin'],
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
