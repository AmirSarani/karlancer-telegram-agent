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
import { notifyOwner, notifyAllOwners, editOwnerMessage } from './telegram/notify.js';
import { notifyBaleOwners } from './telegram/bale-notify.js';
import { createLiveAutoBidRef, createLiveAutoSendRef, readLiveAutoBidFlag, readLiveAutoSendFlag } from './telegram/live-auto-flag.js';
import { createSessionHealthMonitor } from './security/session-health.js';
import { createPermissionGate } from './telegram/permission-gate.js';
import { createMutationRequester } from './telegram/mutation-request.js';
import { maybeNotifySessionExpired } from './telegram/relogin-flow.js';
import { formatScanSummary, afterScanInlineKeyboard, buildScanResultMessage } from './telegram/ui.js';
import {
  shouldNotifyScanSummary,
  readLastScanNotifyFingerprint,
  writeLastScanNotifyFingerprint,
} from './telegram/scan-notify-dedupe.js';
import { formatRoomCard, roomCardKeyboard, roomPickKeyboard, roomPriceKeyboard } from './telegram/room-card.js';
import { createRoomState } from './agent/room-state.js';
import {
  formatMessageSentNotice,
  formatMessageBlockedNotice,
  formatBidBlockedNotice,
  formatFollowUpNotice,
} from './telegram/send-notices.js';
import { formatWinNotice } from './agent/win-watch.js';
import { formatPriceCrawlNotice } from './agent/price-crawl.js';

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
  const liveAutoRef = createLiveAutoBidRef(
    readLiveAutoBidFlag(db, { envDefault: Boolean(config.allowLiveAutoBid) })
  );
  const liveAutoSendRef = createLiveAutoSendRef(
    readLiveAutoSendFlag(db, { envDefault: Boolean(config.allowLiveAutoSend) })
  );
  const morningDigestRef = { current: null };
  const baleTokenRef = { current: config.baleBotToken || '' };
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

  /** One Telegram notify per rooms.scan job (owner-only); auto path fingerprint-deduped. */
  let lastNotifiedScanAt = null;
  /** @type {{ chatId: number, messageId: number, jobId?: string } | null} */
  let pendingScanUi = null;

  async function notifyScanIfNeeded(summary) {
    if (!config.enableTelegram || !config.telegramBotToken || config.telegramOwnerChatId == null) {
      return;
    }
    if (!summary?.scannedAt) return;
    if (lastNotifiedScanAt === summary.scannedAt) return;

    const hasPendingUi = pendingScanUi?.messageId != null;
    const decision = shouldNotifyScanSummary(summary, {
      lastFingerprint: readLastScanNotifyFingerprint(db),
      hasPendingUi,
      forceNotify: Boolean(summary.forceNotify) || summary.scanTrigger === 'manual',
    });

    if (!decision.notify) {
      if (decision.persist) {
        try {
          writeLastScanNotifyFingerprint(db, decision.fingerprint);
        } catch (e) {
          logger.warn('scan_notify_fp_write_failed', { err: e.message });
        }
      }
      logger.info('telegram_scan_notify_skipped', {
        reason: decision.reason,
        page: summary.page,
        unread: summary.unreadOnPage,
        prepared: summary.preparedCount,
        trigger: summary.scanTrigger || 'auto',
      });
      return;
    }

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
        try {
          writeLastScanNotifyFingerprint(db, decision.fingerprint);
        } catch (e) {
          logger.warn('scan_notify_fp_write_failed', { err: e.message });
        }
        logger.info('telegram_scan_edited', {
          page: summary.page,
          unread: summary.unreadOnPage,
          reason: decision.reason,
        });
        return;
      }
      logger.warn('telegram_scan_edit_failed', { error: edited.error });
    }
    const res = await notifyAllOwners({
      token: config.telegramBotToken,
      chatIds: config.telegramOwnerChatIds || [config.telegramOwnerChatId],
      text,
      reply_markup,
    });
    if (!res.ok) {
      logger.warn('telegram_scan_notify_failed', { error: res.errors?.[0] });
    } else {
      try {
        writeLastScanNotifyFingerprint(db, decision.fingerprint);
      } catch (e) {
        logger.warn('scan_notify_fp_write_failed', { err: e.message });
      }
      logger.info('telegram_scan_notified', {
        page: summary.page,
        unread: summary.unreadOnPage,
        sent: res.sent,
        reason: decision.reason,
        trigger: summary.scanTrigger || 'auto',
      });
    }
  }

  const APPROVALS_MARKUP = {
    inline_keyboard: [[{ text: '✅ تأییدها', callback_data: 'goto:approvals' }, { text: '💬 گفتگوها', callback_data: 'goto:chats' }]],
  };

  function roomCardMarkup(card) {
    if (card.continuumAction === 'price_ask') return roomPriceKeyboard(card.roomId);
    return card.pickPrompt || card.continuumAction === 'pick_to_answer' || card.continuumAction === 'auto_hitl'
      ? roomPickKeyboard(card.roomId)
      : roomCardKeyboard(card.roomId);
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
      const freshN = Number(card.freshInboundCount) || (card.freshInboundIds || []).length || 0;
      const action = String(card.continuumAction || '');
      const needsHitl =
        Boolean(card.pickPrompt) ||
        ['pick_to_answer', 'auto_hitl', 'hitl_emergency', 'scan_hitl', 'price_ask'].includes(action);
      // Continuum echo with no new inbound → stay quiet (scan-summary spam spirit)
      if (
        freshN <= 0 &&
        !needsHitl &&
        (action === 'notify' || action === 'notify_only' || action === 'continuum_notify')
      ) {
        logger.info('telegram_room_card_skipped', {
          roomId: card.roomId,
          reason: 'no_fresh_inbound',
          action,
        });
        continue;
      }
      notifiedMsgIds.add(key);
      if (notifiedMsgIds.size > 500) {
        const first = notifiedMsgIds.values().next().value;
        notifiedMsgIds.delete(first);
      }
      const enriched = {
        ...card,
        sendApiLive: Boolean(card.sendApiLive),
        chatAiModeFa: card.chatAiModeFa,
        suggestedPriceFa: card.suggestedPriceFa,
        analysisSummary: card.analysisSummary,
        pickPrompt: Boolean(card.pickPrompt),
        threadPhase: card.threadPhase,
      };
      // Skip noisy notify for silent auto-sent continuum (optional audit-only)
      if (card.continuumAction === 'auto_sent') {
        logger.info('telegram_room_auto_sent', { roomId: card.roomId });
      }
      const text = formatRoomCard(enriched);
      const markup = roomCardMarkup(card);
      const res = await notifyAllOwners({
        token: config.telegramBotToken,
        chatIds: config.telegramOwnerChatIds || [config.telegramOwnerChatId],
        text,
        reply_markup: markup,
      });
      if (!res.ok) {
        logger.warn('telegram_room_card_notify_failed', { roomId: card.roomId, error: res.errors?.[0] });
      } else {
        logger.info('telegram_room_card_notified', {
          roomId: card.roomId,
          fresh: card.freshInboundCount,
          sent: res.sent,
        });
      }
    }
  }


  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });

  async function notifyAllOwnersChannels(text, reply_markup) {
    const chatIds = config.telegramOwnerChatIds || [];
    let tg = { ok: false, sent: 0 };
    if (config.enableTelegram && config.telegramBotToken && chatIds.length) {
      tg = await notifyAllOwners({
        token: config.telegramBotToken,
        chatIds,
        text,
        reply_markup,
      });
      if (!tg.ok) {
        logger.warn('telegram_notify_all_failed', { failed: tg.failed, errors: tg.errors?.slice?.(0, 2) });
      }
    }
    const baleTok = baleTokenRef.current || config.baleBotToken;
    if (baleTok) {
      const bale = await notifyBaleOwners({
        token: baleTok,
        chatIds: config.baleOwnerChatIds?.length ? config.baleOwnerChatIds : chatIds,
        text,
        apiRoot: config.baleApiRoot,
      });
      if (!bale.skipped && !bale.ok) {
        logger.warn('bale_notify_failed', { error: bale.error });
      }
    }
    return tg;
  }

  let sessionHealthPaused = false;
  const sessionHealth = createSessionHealthMonitor({
    api,
    envFile: path.join(config.root, '.env'),
    notifyAllOwners: async (text) => {
      await notifyAllOwnersChannels(text);
    },
    isPaused: () => sessionHealthPaused,
  });

  const worker = createWorker({
    db,
    queue,
    api,
    llm,
    budget,
    gate,
    mutations,
    notifyOpportunity: async (text, meta = {}) => {
      let reply_markup;
      try {
        const opp = meta?.opportunity;
        if (opp?.id) {
          const { opportunityCardKeyboard } = await import('./telegram/opportunity-ux.js');
          reply_markup = opportunityCardKeyboard(opp.id);
        }
      } catch {
        reply_markup = undefined;
      }
      await notifyAllOwnersChannels(text, reply_markup);
    },
    allowLiveAutoBid: liveAutoRef.get(),
    allowLiveAutoSend: liveAutoSendRef.get(),
    getAllowLiveAutoSend: () => liveAutoSendRef.get(),
    gate,
    getAllowLiveAutoBid: () => liveAutoRef.get(),
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
          const {
            formatOpportunityScanResult,
            opportunityScanResultKeyboard,
          } = await import('./telegram/opportunity-ux.js');
          const text = formatOpportunityScanResult(payload);
          await notifyAllOwnersChannels(text, opportunityScanResultKeyboard(payload));
        } catch (e) {
          logger.warn('opportunity_scan_notify_failed', { err: e.message });
        }
      }

      if (type === 'messages.polled' && payload) {
        await notifyRoomCards(payload);
      }

      try {
        if (type === 'message.sent' && payload) {
          await notifyAllOwnersChannels(
            formatMessageSentNotice(payload),
            payload.roomId ? roomCardKeyboard(payload.roomId) : undefined
          );
        } else if (type === 'message.blocked' && payload) {
          await notifyAllOwnersChannels(
            formatMessageBlockedNotice(payload),
            payload.roomId ? roomCardKeyboard(payload.roomId) : undefined
          );
        } else if (type === 'followup.prepared' && Array.isArray(payload?.items)) {
          for (const item of payload.items) {
            if (item.status !== 'pending_approval') continue; // auto ones get «message.sent»
            await notifyAllOwnersChannels(formatFollowUpNotice(item), APPROVALS_MARKUP);
          }
        } else if (type === 'post_win.detected' && payload) {
          await notifyAllOwnersChannels(formatWinNotice(payload), APPROVALS_MARKUP);
        } else if (type === 'chat.price_resumed' && payload?.card) {
          // Auto-sent → the message.sent notice follows; otherwise show the resulting card.
          if (payload.card.continuumAction !== 'auto_sent' && config.enableTelegram && config.telegramBotToken) {
            await notifyAllOwners({
              token: config.telegramBotToken,
              chatIds: config.telegramOwnerChatIds || [config.telegramOwnerChatId],
              text: formatRoomCard(payload.card),
              reply_markup: roomCardMarkup(payload.card),
            });
          }
        } else if (type === 'pricing.crawled' && payload) {
          await notifyAllOwnersChannels(formatPriceCrawlNotice(payload));
        } else if (type === 'bid.blocked' && payload) {
          await notifyAllOwnersChannels(formatBidBlockedNotice(payload));
        }
      } catch (e) {
        logger.warn('send_notice_failed', { type, err: e.message });
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
        allowLiveAutoBid: liveAutoRef.get(),
    allowLiveAutoSend: liveAutoSendRef.get(),
    getAllowLiveAutoSend: () => liveAutoSendRef.get(),
    gate,
        getAllowLiveAutoBid: () => liveAutoRef.get(),
        setAllowLiveAutoBid: (v) => liveAutoRef.set(v),
        getMorningDigest: () => morningDigestRef.current,
        mcpHost: config.mcpHttpHost,
        mcpPort: config.mcpHttpPort,
        mcpApiKeySet: Boolean(config.mcpApiKey),
        baleConfigured: Boolean(config.baleBotToken),
        isBaleConfigured: () => Boolean(baleTokenRef.current),
        setBaleToken: (t) => {
          baleTokenRef.current = t || '';
        },
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
        await notifyAllOwnersChannels(text);
      },
      auth: {
        hasAuth: Boolean(api.client.hasAuth),
        envFile: path.join(config.root, '.env'),
      },
      pendingApprovals: () => queue.pendingApprovals().length,
      isPaused: () => runtime.state === 'paused',
    });
    morningDigestRef.current = morningDigest;
    morningDigest.start(60_000);

    sessionHealth.start(15 * 60_000);
    setInterval(() => {
      try {
        sessionHealthPaused = runtime.state === 'paused';
      } catch {
        /* ignore */
      }
    }, 5_000).unref?.();

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
        sessionHealth.stop();
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
      allowLiveAutoBid: Boolean(config.allowLiveAutoBid),
      bale: Boolean(config.baleBotToken),
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
