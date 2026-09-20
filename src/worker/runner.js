/**
 * Durable worker loop — claim → handle → succeed/fail/retry.
 * Can run as standalone process: `npm run worker`
 */
import crypto from 'node:crypto';
import { loadAppConfig } from '../config.js';
import { openDb } from '../memory/db.js';
import { createJobQueue } from './queue.js';
import { createKarlancerApi } from '../api/adapters/index.js';
import { handleJob } from './handlers.js';
import { logger } from '../observability/logger.js';
import { bumpHandoffMeta } from '../memory/handoff.js';

export function createWorker(ctx) {
  const workerId = ctx.workerId || `worker-${crypto.randomUUID().slice(0, 8)}`;
  let stopped = false;
  let state = 'idle';

  async function tick() {
    if (stopped) return;
    const job = ctx.queue.claim(workerId, { leaseMs: ctx.leaseMs || 60_000 });
    if (!job) {
      state = 'idle';
      return;
    }
    state = 'busy';
    logger.info('job_start', { jobId: job.jobId, goal: job.goal, attempt: job.attempt });
    try {
      const outcome = await handleJob(ctx, job);
      if (outcome.terminal && !outcome.ok) {
        // status already set (e.g. needs_reconciliation)
        logger.warn('job_terminal_soft_fail', { jobId: job.jobId, code: outcome.errorCode });
        return;
      }
      if (!outcome.ok) {
        if (['missing_auth', 'unknown_goal', 'unauthorized'].includes(outcome.errorCode)) {
          ctx.queue.fail(job.jobId, outcome.errorCode, outcome.detail || {});
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
      } else {
        ctx.queue.retryOrDead(job.jobId, { errorCode: e.code || 'exception' });
      }
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
    },
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
  const queue = createJobQueue(db);
  const api = createKarlancerApi({
    baseUrl: config.karlancerBaseUrl,
    accessToken: config.karlancerAccessToken,
    cookie: config.karlancerCookie,
    timeoutMs: config.karlancerTimeoutMs,
  });
  const worker = createWorker({ db, queue, api, leaseMs: 60_000, pollMs: 400 });
  const shutdown = async (sig) => {
    logger.info('worker_shutdown', { sig });
    await worker.stop();
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
