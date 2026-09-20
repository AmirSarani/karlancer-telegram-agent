import { loadAppConfig } from './config.js';
import { createBot } from './telegram/bot.js';
import { openDb } from './memory/db.js';
import { createJobQueue } from './worker/queue.js';
import { createWorker } from './worker/runner.js';
import { createKarlancerApi } from './api/adapters/index.js';
import { RoomMemory } from './agent/memory.js';
import { bumpHandoffMeta } from './memory/handoff.js';
import { logger } from './observability/logger.js';
import { buildHealth } from './observability/health.js';

async function main() {
  let config;
  try {
    config = loadAppConfig({ requireTelegram: true, requireOwner: true });
  } catch (err) {
    if (String(err.message || err).includes('TELEGRAM_OWNER_CHAT_ID')) {
      console.warn(err.message);
      config = loadAppConfig({ requireTelegram: true, requireOwner: false });
    } else {
      throw err;
    }
  }

  const db = openDb(config.dbPath);
  const queue = createJobQueue(db);
  const api = createKarlancerApi({
    baseUrl: config.karlancerBaseUrl,
    accessToken: config.karlancerAccessToken,
    cookie: config.karlancerCookie,
    timeoutMs: config.karlancerTimeoutMs,
  });

  const memory = new RoomMemory(config.memoryDir);
  await memory.ensureDir();

  const worker = createWorker({
    db,
    queue,
    api,
    leaseMs: 60_000,
    pollMs: 500,
  });

  // Gate worker on telegram pause state
  const startedAt = Date.now();
  let workerTask = null;

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

  // Wrap claim path: if paused, skip processing by stopping loop temporarily
  if (config.enableWorker) {
    const origStart = worker.start.bind(worker);
    workerTask = (async () => {
      while (true) {
        if (runtime.state === 'paused') {
          await sleep(1000);
          continue;
        }
        // single tick via internal — restart loop each resume is heavy; use polling wrapper
        try {
          // claim+handle one via exporting tick — recreate lightweight poll
          const job = queue.claim(worker.workerId);
          if (job) {
            const { handleJob } = await import('./worker/handlers.js');
            try {
              const outcome = await handleJob({ api, db, queue }, job);
              if (outcome.terminal && !outcome.ok) {
                /* already set */
              } else if (!outcome.ok) {
                if (['missing_auth', 'unknown_goal', 'unauthorized'].includes(outcome.errorCode)) {
                  queue.fail(job.jobId, outcome.errorCode, outcome.detail || {});
                } else {
                  queue.retryOrDead(job.jobId, { errorCode: outcome.errorCode || 'handler_error' });
                }
              } else {
                queue.succeed(job.jobId, outcome.result || {});
              }
            } catch (e) {
              queue.retryOrDead(job.jobId, { errorCode: e.code || 'exception' });
            }
          }
        } catch (e) {
          logger.error('embedded_worker_error', { err: e.message });
        }
        await sleep(500);
      }
    })();
    void origStart; // standalone runner still available via npm run worker
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
      'bids.submit try-list (approval)',
      'mcp stdio/http',
      'sqlite jobs',
    ],
    commit: process.env.GIT_COMMIT || 'local',
  });

  const shutdown = async (signal) => {
    logger.info('main_shutdown', { signal });
    try {
      await stop();
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
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('[main] fatal', err);
  process.exit(1);
});
