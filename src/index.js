import { loadAppConfig } from './config.js';
import { openDb, acquireSingleNodeLock } from './memory/db.js';
import { createJobQueue } from './worker/queue.js';
import { createWorker } from './worker/runner.js';
import { createKarlancerApi } from './api/adapters/index.js';
import { RoomMemory } from './agent/memory.js';
import { bumpHandoffMeta } from './memory/handoff.js';
import { logger } from './observability/logger.js';
import { buildHealth } from './observability/health.js';
import { createScheduler } from './worker/scheduler.js';
import { createLlmProvider, recordTokenUsage } from './llm/provider.js';
import { TokenBudgetManager } from './intelligence/token-budget.js';

async function main() {
  // MCP-only / headless: ENABLE_TELEGRAM=false must not require Telegram token
  const enableTelegramEnv = String(process.env.ENABLE_TELEGRAM || 'true').toLowerCase() !== 'false';
  let config = loadAppConfig({
    requireTelegram: enableTelegramEnv,
    requireOwner: enableTelegramEnv,
  });

  if (!config.enableTelegram) {
    logger.info('telegram_disabled', { note: 'ENABLE_TELEGRAM=false — MCP/worker only mode' });
  }

  const db = openDb(config.dbPath);
  let nodeLock;
  try {
    nodeLock = acquireSingleNodeLock(db, `main-${process.pid}`);
    nodeLock.startHeartbeat();
  } catch (e) {
    logger.error('single_node_lock', { err: e.message });
    process.exit(1);
  }

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

  const memory = new RoomMemory(config.memoryDir);
  await memory.ensureDir();

  const worker = createWorker({
    db,
    queue,
    api,
    llm,
    budget,
    leaseMs: 60_000,
    pollMs: 500,
    onEvent: async (type, payload) => {
      await bumpHandoffMeta(db, config.stateDir, {
        agent: 'main',
        status: 'running',
        lastChange: `${type}`,
        nextAction: 'continue',
        queueDepth: queue.list({ status: 'queued', limit: 100 }).length,
        pendingApprovals: queue.pendingApprovals().length,
        blockers: api.client.hasAuth ? [] : ['KARLANCER_ACCESS_TOKEN missing'],
        inProgress: [type],
        capabilities: ['api-adapters', 'worker', 'sqlite', 'mcp', 'llm'],
      });
    },
  });

  const scheduler = createScheduler({ db, queue });
  scheduler.ensureDefaults();

  const startedAt = Date.now();
  let stopTelegram = async () => {};

  if (config.enableTelegram && config.telegramBotToken) {
    const { createBot } = await import('./telegram/bot.js');
    const { bot, start, runtime, stop } = createBot({
      token: config.telegramBotToken,
      ownerChatId: config.telegramOwnerChatId,
      hooks: {
        queue,
        onStatus: async () => {
          const h = buildHealth({ db, worker, startedAt });
          return [
            `db: ${h.db}`,
            `worker: ${h.worker}`,
            `queue_depth: ${h.queue_depth}`,
            `karlancer_auth: ${api.client.hasAuth ? 'token/cookie set' : 'MISSING'}`,
            `openai: ${config.openaiApiKey ? 'key set' : 'no key'}`,
            `playwright: not used`,
          ].join('\n');
        },
      },
    });
    stopTelegram = stop;
    void bot;

    if (config.enableWorker) {
      (async () => {
        while (true) {
          if (runtime.state === 'paused') {
            scheduler.pauseAll();
            await sleep(1000);
            continue;
          }
          scheduler.resumeAll();
          try {
            await worker._tick();
          } catch (e) {
            logger.error('embedded_worker_error', { err: e.message });
          }
          await sleep(500);
        }
      })();
    }

    await bumpHandoffMeta(db, config.stateDir, {
      agent: 'main',
      status: 'running',
      lastChange: 'boot api-first agent (telegram+worker)',
      nextAction: 'await owner commands / MCP clients',
      queueDepth: 0,
      pendingApprovals: 0,
      blockers: api.client.hasAuth ? [] : ['KARLANCER_ACCESS_TOKEN missing'],
      inProgress: ['telegram long-poll', config.enableWorker ? 'embedded worker' : 'worker disabled'],
      capabilities: [
        'rooms.list',
        'messages.list',
        'projects.public',
        'bids.check',
        'bids.submit VerifiedMutationContract (blocked until HAR)',
        'mcp stdio/http',
        'sqlite jobs',
        'llm analyze/proposal/draft',
      ],
      commit: process.env.GIT_COMMIT || 'local',
    });

    scheduler.start();
    const shutdown = async (signal) => {
      logger.info('main_shutdown', { signal });
      await worker.stop();
      scheduler.stop();
      try {
        nodeLock?.release();
      } catch {
        /* ignore */
      }
      try {
        await stopTelegram();
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    logger.info('main_boot', {
      owner: config.telegramOwnerChatId ?? 'unset',
      auth: api.client.hasAuth,
      db: config.dbPath,
    });
    await start();
  } else {
    // Headless: worker + scheduler only (MCP via separate process)
    if (config.enableWorker) {
      worker.start();
    }
    scheduler.start();
    await bumpHandoffMeta(db, config.stateDir, {
      agent: 'main-headless',
      status: 'running',
      lastChange: 'boot without Telegram (ENABLE_TELEGRAM=false)',
      nextAction: 'use MCP stdio/http',
      queueDepth: 0,
      pendingApprovals: 0,
      blockers: api.client.hasAuth ? [] : ['KARLANCER_ACCESS_TOKEN missing'],
      inProgress: [config.enableWorker ? 'worker' : 'idle'],
      capabilities: ['worker', 'scheduler', 'sqlite'],
    });

    const shutdown = async (signal) => {
      logger.info('main_shutdown', { signal });
      await worker.stop();
      scheduler.stop();
      try {
        nodeLock?.release();
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    logger.info('main_boot_headless', { auth: api.client.hasAuth, db: config.dbPath });
    // Keep process alive
    await new Promise(() => {});
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('[main] fatal', err);
  process.exit(1);
});
