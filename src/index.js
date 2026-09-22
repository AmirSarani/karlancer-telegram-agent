import path from 'node:path';
import { loadAppConfig } from './config.js';
import { openDb, acquireSingleWorkerConsumerLock } from './memory/db.js';
import { createJobQueue } from './worker/queue.js';
import { createWorker } from './worker/runner.js';
import { createKarlancerApi } from './api/adapters/index.js';
import { RoomMemory } from './agent/memory.js';
import { bumpHandoffMeta } from './memory/handoff.js';
import { logger } from './observability/logger.js';
import { buildHealth } from './observability/health.js';
import { createScheduler } from './worker/scheduler.js';
import { createMorningDigest } from './opportunity/morning-digest.js';
import { createLlmProvider, recordTokenUsage } from './llm/provider.js';
import { TokenBudgetManager } from './intelligence/token-budget.js';
import { notifyOwner, editOwnerMessage } from './telegram/notify.js';
import { maybeNotifySessionExpired } from './telegram/relogin-flow.js';
import { formatScanSummary, afterScanInlineKeyboard, buildScanResultMessage } from './telegram/ui.js';
import { formatRoomCard, roomCardKeyboard } from './telegram/room-card.js';
import { createRoomState } from './agent/room-state.js';

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
    nodeLock = acquireSingleWorkerConsumerLock(db, `main-${process.pid}`);
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

  // Soft-notify owners on Karlancer 401/403 (rate-limited); never include token.
  api.client.onUnauthorized = ({ status, path: pth }) => {
    void status;
    void pth;
    if (!config.enableTelegram || !config.telegramBotToken) return;
    const owners = config.telegramOwnerChatIds || [];
    void maybeNotifySessionExpired({
      ownerChatIds: owners,
      notify: async (chatId, text) => {
        await notifyOwner({
          token: config.telegramBotToken,
          chatId,
          text,
        });
      },
    });
  };


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

  function readLastScan() {
    try {
      const row = db.prepare(`SELECT value, updated_at FROM kv WHERE key = 'last_scan_summary'`).get();
      if (!row?.value) return null;
      const summary = JSON.parse(row.value);
      return { ...summary, scannedAt: summary.scannedAt || row.updated_at };
    } catch {
      return null;
    }
  }

  /** One Telegram notify per rooms.scan job (owner-only). */
  let lastNotifiedScanAt = null;
  /** @type {{ chatId: number, messageId: number, jobId?: string } | null} */
  let pendingScanUi = null;

  async function notifyScanIfNeeded(summary) {
    if (!config.enableTelegram || !config.telegramBotToken || config.telegramOwnerChatId == null) {
      return;
    }
    if (!summary?.scannedAt) return;
    if (lastNotifiedScanAt === summary.scannedAt) return;
    lastNotifiedScanAt = summary.scannedAt;
    const built = buildScanResultMessage(summary);
    const text = built.text || formatScanSummary(summary);
    const reply_markup = built.reply_markup || afterScanInlineKeyboard(summary);
    if (pendingScanUi?.messageId != null) {
      const edited = await editOwnerMessage({
        token: config.telegramBotToken,
        chatId: pendingScanUi.chatId ?? config.telegramOwnerChatId,
        messageId: pendingScanUi.messageId,
        text,
        reply_markup,
      });
      pendingScanUi = null;
      if (edited.ok) {
        logger.info('telegram_scan_edited', { page: summary.page, unread: summary.unreadOnPage });
        return;
      }
      logger.warn('telegram_scan_edit_failed', { error: edited.error });
    }
    const res = await notifyOwner({
      token: config.telegramBotToken,
      chatId: config.telegramOwnerChatId,
      text,
      reply_markup,
    });
    if (!res.ok) {
      logger.warn('telegram_scan_notify_failed', { error: res.error });
    } else {
      logger.info('telegram_scan_notified', { page: summary.page, unread: summary.unreadOnPage });
    }
  }

  /** Notify owner with full room cards for new inbound messages. */
  const notifiedMsgIds = new Set();
  async function notifyRoomCards(payload) {
    if (!config.enableTelegram || !config.telegramBotToken || config.telegramOwnerChatId == null) {
      return;
    }
    const cards = Array.isArray(payload?.cards) ? payload.cards : [];
    for (const card of cards) {
      const key = `${card.roomId}:${(card.freshInboundIds || []).join(',') || card.updatedAt || ''}`;
      if (notifiedMsgIds.has(key)) continue;
      notifiedMsgIds.add(key);
      if (notifiedMsgIds.size > 500) {
        const first = notifiedMsgIds.values().next().value;
        notifiedMsgIds.delete(first);
      }
      const text = formatRoomCard({ ...card, sendApiLive: Boolean(card.sendApiLive) });
      const res = await notifyOwner({
        token: config.telegramBotToken,
        chatId: config.telegramOwnerChatId,
        text,
        reply_markup: roomCardKeyboard(card.roomId),
      });
      if (!res.ok) {
        logger.warn('telegram_room_card_notify_failed', { roomId: card.roomId, error: res.error });
      } else {
        logger.info('telegram_room_card_notified', { roomId: card.roomId, fresh: card.freshInboundCount });
      }
    }
  }

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
      if (type === 'rooms.scanned' && payload) {
        await notifyScanIfNeeded(payload);
      }
      
      if (type === 'opportunities.scanned' && payload && !payload.skipped) {
        try {
          const { formatOpportunityScanResult } = await import('./telegram/opportunity-ux.js');
          const text = formatOpportunityScanResult(payload);
          if (config.enableTelegram && config.telegramBotToken && config.telegramOwnerChatId != null) {
            await notifyOwner({
              token: config.telegramBotToken,
              chatId: config.telegramOwnerChatId,
              text,
            });
          }
        } catch (e) {
          logger.warn('opportunity_scan_notify_failed', { err: e.message });
        }
      }

      if (type === 'messages.polled' && payload) {
        await notifyRoomCards(payload);
      }
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
      ownerChatIds: config.telegramOwnerChatIds,
      hooks: {
        envFile: path.join(config.root, '.env'),
        onScanMessage: (info) => {
          pendingScanUi = info;
        },
        queue,
        db,
        api,
        llm,
        onStatus: async () => {
          const h = buildHealth({ db, worker, startedAt });
          const last = readLastScan();
          const roomState = createRoomState(db);
          const poll = roomState.getPollHealth();
          return {
            db: h.db,
            worker: h.worker,
            karlancerAuth: Boolean(api.client.hasAuth),
            lastScanAt: last?.scannedAt || null,
            lastScanUnread: last?.unreadOnPage ?? null,
            lastPollAt: poll?.polledAt || null,
            pendingRooms: roomState.pendingCount(),
            pollOk: typeof poll?.ok === 'boolean' ? poll.ok : null,
            extra: [
              `openai: ${config.openaiApiKey ? 'فعال' : 'بدون کلید'}`,
              'playwright: استفاده نمی‌شود',
              `send_api: ${poll?.sendApiLive ? 'live' : 'blocked_by_missing_api'}`,
            ].join('\n'),
          };
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

    const morningDigest = createMorningDigest({
      db,
      notify: async (text) => {
        if (!config.telegramBotToken || config.telegramOwnerChatId == null) return;
        await notifyOwner({
          token: config.telegramBotToken,
          chatId: config.telegramOwnerChatId,
          text,
        });
      },
      auth: {
        hasAuth: Boolean(api.client.hasAuth),
        envFile: path.join(config.root, '.env'),
      },
      pendingApprovals: () => queue.pendingApprovals().length,
      isPaused: () => runtime.state === 'paused',
    });
    morningDigest.start(60_000);

    const shutdown = async (signal) => {
      logger.info('main_shutdown', { signal });
      await worker.stop();
      scheduler.stop();
      try {
        morningDigest.stop();
      } catch {
        /* ignore */
      }
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
      owners: config.telegramOwnerChatIds ?? [],
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
