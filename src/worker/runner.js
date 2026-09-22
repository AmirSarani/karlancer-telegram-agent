/**
 * Durable worker loop — claim → heartbeat → handle → succeed/fail/retry.
 * Can run as standalone process: `npm run worker`
 */
import crypto from 'node:crypto';
import { loadAppConfig } from '../config.js';
import { openDb, acquireSingleWorkerConsumerLock } from '../memory/db.js';
import { createJobQueue } from './queue.js';
import { createKarlancerApi } from '../api/adapters/index.js';
import { handleJob } from './handlers.js';
import { logger } from '../observability/logger.js';
import { bumpHandoffMeta } from '../memory/handoff.js';
import { createScheduler } from './scheduler.js';
import { createLlmProvider, recordTokenUsage } from '../llm/provider.js';
import { TokenBudgetManager } from '../intelligence/token-budget.js';
import { createPermissionGate } from '../telegram/permission-gate.js';
import { createMutationRequester } from '../telegram/mutation-request.js';
import { readLiveAutoSendFlag } from '../telegram/live-auto-flag.js';
import { notifyAllOwners } from '../telegram/notify.js';
import { notifyBaleOwners } from '../telegram/bale-notify.js';

export function createWorker(ctx) {
  const workerId = ctx.workerId || `worker-${crypto.randomUUID().slice(0, 8)}`;
  const leaseMs = ctx.leaseMs || 60_000;
  const heartbeatMs = ctx.heartbeatMs || Math.min(20_000, Math.floor(leaseMs / 3));
  let stopped = false;
  let state = 'idle';
  /** @type {ReturnType<typeof setInterval>|null} */
  let hbTimer = null;

  function stopHeartbeat() {
    if (hbTimer) {
      clearInterval(hbTimer);
      hbTimer = null;
    }
  }

  function startHeartbeat(jobId) {
    stopHeartbeat();
    hbTimer = setInterval(() => {
      try {
        const ok = ctx.queue.heartbeat(jobId, workerId, { leaseMs });
        if (!ok) logger.warn('heartbeat_rejected', { jobId, workerId });
      } catch (e) {
        logger.warn('heartbeat_error', { err: e.message });
      }
    }, heartbeatMs);
    if (typeof hbTimer.unref === 'function') hbTimer.unref();
  }

  async function tick() {
    if (stopped) return;
    const job = ctx.queue.claim(workerId, { leaseMs });
    if (!job) {
      state = 'idle';
      return;
    }
    state = 'busy';
    logger.info('job_start', { jobId: job.jobId, goal: job.goal, attempt: job.attempt, workerId });
    startHeartbeat(job.jobId);
    try {
      const outcome = await handleJob(ctx, job);
      if (outcome.terminal && !outcome.ok) {
        logger.warn('job_terminal_soft_fail', { jobId: job.jobId, code: outcome.errorCode });
        return;
      }
      if (!outcome.ok) {
        if (['missing_auth', 'unknown_goal', 'unauthorized', 'budget_exceeded', 'llm_disabled'].includes(outcome.errorCode)) {
          ctx.queue.fail(job.jobId, outcome.errorCode, outcome.detail || {});
        } else if (outcome.errorCode === 'needs_reconciliation' || outcome.errorCode === 'unknown_side_effect') {
          ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
            errorCode: outcome.errorCode,
            result: outcome.detail,
          });
        } else {
          ctx.queue.retryOrDead(job.jobId, { errorCode: outcome.errorCode || 'handler_error' });
        }
        return;
      }
      ctx.queue.succeed(job.jobId, outcome.result || {});
      logger.info('job_ok', { jobId: job.jobId, goal: job.goal });
    } catch (e) {
      logger.error('job_exception', { jobId: job.jobId, err: e.message, code: e.code });
      if (e.code === 'unauthorized' || e.code === 'missing_auth') {
        ctx.queue.fail(job.jobId, e.code, { message: e.message });
      } else if (e.code === 'timeout' || e.code === 'network' || e.code === 'upstream_5xx') {
        // If this was a mutation goal, do not blind-retry — reconcile
        if (job.goal === 'bids.submit' || job.goal === 'messages.send') {
          ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
            errorCode: e.code || 'unknown_side_effect',
            result: { message: e.message, retryForbidden: true },
          });
        } else {
          ctx.queue.retryOrDead(job.jobId, { errorCode: e.code || 'exception' });
        }
      } else {
        ctx.queue.retryOrDead(job.jobId, { errorCode: e.code || 'exception' });
      }
    } finally {
      stopHeartbeat();
    }
  }

  async function loop() {
    state = 'running';
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        logger.error('worker_tick_error', { err: e.message });
      }
      await sleep(ctx.pollMs || 500);
    }
    stopHeartbeat();
    state = 'stopped';
  }

  return {
    workerId,
    get state() {
      return state;
    },
    start() {
      stopped = false;
      return loop();
    },
    async stop() {
      stopped = true;
      stopHeartbeat();
    },
    /** expose for tests */
    _tick: tick,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// CLI entry
const isMain = process.argv[1] && process.argv[1].endsWith('runner.js');
if (isMain) {
  const config = loadAppConfig({ requireTelegram: false });
  const db = openDb(config.dbPath);
  let nodeLock;
  try {
    nodeLock = acquireSingleWorkerConsumerLock(db, `worker-${process.pid}`);
    nodeLock.startHeartbeat();
  } catch (e) {
    logger.error('single_node_lock', { err: e.message, holder: e.holder });
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
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  async function notifyOpportunity(text, meta = {}) {
    const ids = config.telegramOwnerChatIds || [];
    let reply_markup;
    try {
      const opp = meta?.opportunity;
      if (opp?.id) {
        const { opportunityCardKeyboard } = await import('../telegram/opportunity-ux.js');
        reply_markup = opportunityCardKeyboard(opp.id);
      }
    } catch {
      reply_markup = undefined;
    }
    if (config.telegramBotToken && ids.length) {
      await notifyAllOwners({ token: config.telegramBotToken, chatIds: ids, text, reply_markup });
    }
    if (config.baleBotToken) {
      await notifyBaleOwners({
        token: config.baleBotToken,
        chatIds: config.baleOwnerChatIds?.length ? config.baleOwnerChatIds : ids,
        text,
        apiRoot: config.baleApiRoot,
      });
    }
  }
  const allowLiveAutoSend = readLiveAutoSendFlag(db, {
    envDefault: Boolean(config.allowLiveAutoSend),
  });
  const worker = createWorker({
    db,
    queue,
    api,
    llm,
    budget,
    gate,
    mutations,
    notifyOpportunity,
    allowLiveAutoBid: Boolean(config.allowLiveAutoBid),
    allowLiveAutoSend,
    getAllowLiveAutoSend: () =>
      readLiveAutoSendFlag(db, { envDefault: Boolean(config.allowLiveAutoSend) }),
    leaseMs: 60_000,
    pollMs: 400,
    onEvent: async (type, payload) => {
      await bumpHandoffMeta(db, config.stateDir, {
        agent: worker.workerId,
        status: 'running',
        lastChange: `${type} ${JSON.stringify(payload).slice(0, 120)}`,
        nextAction: 'continue worker loop',
        queueDepth: queue.list({ status: 'queued', limit: 100 }).length,
        pendingApprovals: queue.pendingApprovals().length,
        blockers: [],
        inProgress: [type],
        capabilities: ['api-adapters', 'worker', 'sqlite', 'llm'],
      });
    },
  });
  const scheduler = createScheduler({ db, queue });
  scheduler.ensureDefaults();
  scheduler.start();

  const shutdown = async (sig) => {
    logger.info('worker_shutdown', { sig });
    await worker.stop();
    scheduler.stop();
    try {
      nodeLock?.release();
    } catch {
      /* ignore */
    }
    try {
      await bumpHandoffMeta(db, config.stateDir, {
        agent: worker.workerId,
        status: 'stopped',
        lastChange: `worker stopped (${sig})`,
        nextAction: 'restart worker',
        queueDepth: queue.list({ status: 'queued', limit: 100 }).length,
        pendingApprovals: queue.pendingApprovals().length,
        blockers: [],
        inProgress: [],
        capabilities: ['api-adapters', 'worker', 'sqlite'],
      });
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  logger.info('worker_boot', { workerId: worker.workerId, db: config.dbPath });
  worker.start();
}
