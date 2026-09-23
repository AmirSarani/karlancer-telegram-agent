import { Bot } from 'grammy';
import {
  BOT_COMMANDS,
  mainMenuKeyboard,
  statusInlineKeyboard,
  afterScanInlineKeyboard,
  settingsInlineKeyboard,
  modeInlineKeyboard,
  togglesInlineKeyboard,
  rulesInlineKeyboard,
  homeInlineKeyboard,
  approvalActionKeyboard,
  parseCallbackData,
  formatStatusCard,
  formatApprovalsList,
  formatApprovalDetail,
  formatWelcome,
  formatHelp,
  formatSettingsCard,
  formatModeCard,
  formatChatAiModeCard,
  chatAiModeInlineKeyboard,
  chatAiModeLabelFa,
  toggleConfirmKeyboard,
  formatToggleConfirmCard,
  formatRulesCard,
  formatTogglesCard,
  formatEmergencyCard,
  formatSystemDetails,
  systemDetailsKeyboard,
  formatScanQueued,
  actionLabelFa,
  truncatePreview,
  toFaNum,
  findActiveScanJob,
  formatScanAlreadyRunning,
  formatScanDetails,
  formatScanPriorityList,
  formatScanUnreadList,
  formatScanRoomCard,
  buildScanKeyboard,
  buildScanDetailsKeyboard,
  buildScanPriorityKeyboard,
  buildScanUnreadKeyboard,
  buildScanRoomKeyboard,
  buildScanResultMessage,
  formatDecideResult,
  formatFriendlyError,
  mapMenuText,
  formatAgeFa,
  approvalTarget,
} from './ui.js';
import { createPermissionGate } from './permission-gate.js';
import { createMutationRequester } from './mutation-request.js';
import {
  formatOpportunityCard,
  formatOpportunityDetails,
  opportunityCardKeyboard,
  opportunityScanResultKeyboard,
  OPP_BATCH_PREP_CAP,
  smartBidKeyboard,
  opportunitiesListKeyboard,
  opportunityRulesKeyboard,
  opportunityRuleDetailKeyboard,
  scoringProfileKeyboard,
  formatScoringProfile,
  formatOpportunitiesHub,
  formatOpportunityScanResult,
  formatOpportunityRule,
  formatRuleEditorHelp,
  parseRuleCreateText,
  formatDecisionInbox,
  decisionInboxKeyboard,
  parseOpportunityCallback,
} from './opportunity-ux.js';
import {
  BOOK_PAGE_SIZE,
  BOOK_NEW_WITHIN_HOURS,
  parseBookCallback,
  formatBookHome,
  bookHomeKeyboard,
  formatBookOppList,
  bookOppListKeyboard,
  formatBookActions,
  bookActionsKeyboard,
  formatBookDrafts,
  bookDraftsKeyboard,
  formatBookDraftDetail,
  bookDraftDetailKeyboard,
  formatBookScans,
  bookScansKeyboard,
  formatBookScanRun,
  bookScanRunKeyboard,
  formatBookOppDetail,
  bookOppDetailKeyboard,
} from './opportunity-book.js';
import { createOpportunityScanner } from '../opportunity/scanner.js';
import { createOpportunityStore } from '../opportunity/store.js';
import { isScoringConfigured } from '../opportunity/scoring.js';
import { buildSmartBid } from '../opportunity/smart-bid.js';
import { createFeedbackStore } from '../opportunity/feedback.js';
import { createWizardState } from './wizard-state.js';
import { checkTokenHealth, formatTokenWarningFa } from '../security/token-health.js';
import { formatPostWinSectionFa, scanNotificationsForWins, advancePostWin } from '../opportunity/post-win.js';

import { redactString } from '../security/redaction.js';
import { createRoomFlows } from './room-flows.js';
import {
  beginRelogin,
  beginTokenPaste,
  beginPasswordFallback,
  clearReloginState,
  getReloginState,
  handleReloginText,
  MSG as RELOGIN_MSG,
  reloginCancelKeyboard,
  reloginChoiceKeyboard,
} from './relogin-flow.js';
import { createControlHandlers } from './control-handlers.js';
import { readLiveAutoBidFlag } from './live-auto-flag.js';

/**
 * Normalize owner id list from ownerChatIds and/or legacy ownerChatId.
 * @param {{ ownerChatId?: number|null, ownerChatIds?: number[]|null }} opts
 * @returns {number[]}
 */
export function resolveOwnerChatIds({ ownerChatId = null, ownerChatIds = null } = {}) {
  const raw = Array.isArray(ownerChatIds) && ownerChatIds.length
    ? ownerChatIds
    : ownerChatId != null
      ? [ownerChatId]
      : [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isFinite(n) || Number.isNaN(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * @param {import('grammy').Context|object} ctx
 * @param {number[]} owners
 */
export function isOwnerContext(ctx, owners) {
  if (!owners || owners.length === 0) return false;
  const chatId = ctx?.chat?.id;
  const fromId = ctx?.from?.id;
  return owners.includes(chatId) || owners.includes(fromId);
}

/**
 * Owner-only Telegram AI Operations Dashboard.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {number|null} [opts.ownerChatId] primary / legacy single owner
 * @param {number[]} [opts.ownerChatIds] allowlist (preferred; may include primary)
 * @param {{ queue?: object, onStatus?: Function, db?: object, api?: object, llm?: object }} [opts.hooks]
 */
export function createBot({ token, ownerChatId, ownerChatIds, hooks = {} }) {
  const bot = new Bot(token);
  const queue = hooks.queue || null;
  const db = hooks.db || null;
  const api = hooks.api || null;
  const llm = hooks.llm || null;
  const owners = resolveOwnerChatIds({ ownerChatId, ownerChatIds });

  /** @type {{ state: 'running'|'paused', startedAt: string, lastCommandAt: string|null }} */
  const runtime = {
    state: 'running',
    startedAt: new Date().toISOString(),
    lastCommandAt: null,
  };

  function isOwner(ctx) {
    return isOwnerContext(ctx, owners);
  }

  async function denyIfNotOwner(ctx, { asCallback = false } = {}) {
    if (isOwner(ctx)) return false;
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    const msg =
      owners.length === 0
        ? `این بات هنوز به owner قفل نشده.\nchat id شما: \`${chatId}\`\nآن را در TELEGRAM_OWNER_CHAT_ID بگذارید و بات را ری‌استارت کنید.`
        : 'دسترسی فقط برای owner است.';
    if (asCallback) {
      try {
        await ctx.answerCallbackQuery({ text: 'دسترسی مجاز نیست', show_alert: true });
      } catch {
        /* ignore */
      }
    } else {
      await ctx.reply(msg);
    }
    return true;
  }

  function touch() {
    runtime.lastCommandAt = new Date().toISOString();
  }

  function pendingCount() {
    return queue ? queue.pendingApprovals().length : 0;
  }

  function menuOpts() {
    return { reply_markup: mainMenuKeyboard(runtime.state) };
  }

  const gate = db != null ? createPermissionGate(db) : null;
  const mutations =
    queue && gate ? createMutationRequester({ queue, gate }) : null;

  const roomFlows =
    db != null
      ? createRoomFlows({ db, queue, api, llm, menuOpts, gate, mutations })
      : null;
  const wizard = db != null ? createWizardState(db) : null;

  /** @type {{ chatId: number, messageId: number, jobId?: string } | null} */
  let pendingScanMessage = null;

  function setPendingScanMessage(info) {
    pendingScanMessage = info;
    if (typeof hooks.onScanMessage === 'function') {
      try {
        hooks.onScanMessage(info);
      } catch {
        /* ignore */
      }
    }
  }

  async function editOrReply(ctx, text, extra = {}, { edit = false } = {}) {
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, extra);
        const messageId = ctx.callbackQuery.message?.message_id;
        const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat?.id;
        return { edited: true, messageId, chatId };
      } catch {
        /* fall through */
      }
    }
    const msg = await ctx.reply(text, { ...menuOpts(), ...extra });
    return {
      edited: false,
      messageId: msg?.message_id,
      chatId: ctx.chat?.id ?? msg?.chat?.id,
    };
  }

  const controlBridges = {
    replyOpportunitiesHub: null,
    replyOpportunityRules: null,
    replyScoringProfile: null,
    doOpportunityScan: null,
    replyPostWin: null,
  };

  const control = createControlHandlers({
    db,
    api,
    runtime,
    owners,
    editOrReply,
    menuOpts,
    wizard,
    hooks,
    getMorningDigest: () =>
      typeof hooks.getMorningDigest === 'function'
        ? hooks.getMorningDigest()
        : hooks.morningDigest || null,
    replyOpportunitiesHub: (ctx, opts) => controlBridges.replyOpportunitiesHub?.(ctx, opts),
    replyOpportunityRules: (ctx, opts) => controlBridges.replyOpportunityRules?.(ctx, opts),
    replyScoringProfile: (ctx, opts) => controlBridges.replyScoringProfile?.(ctx, opts),
    doOpportunityScan: (ctx, opts) => controlBridges.doOpportunityScan?.(ctx, opts),
    replyPostWin: (ctx, opts) => controlBridges.replyPostWin?.(ctx, opts),
  });

  function readLastScanSummary() {
    if (!db) return null;
    try {
      const row = db.prepare(`SELECT value, updated_at FROM kv WHERE key = 'last_scan_summary'`).get();
      if (!row?.value) return null;
      const summary = JSON.parse(row.value);
      return { ...summary, scannedAt: summary.scannedAt || row.updated_at };
    } catch {
      return null;
    }
  }

  async function renderScanView(ctx, view, { edit = true, page = 1, roomId = null } = {}) {
    const summary = readLastScanSummary() || {};
    if (view === 'summary') {
      const { text, reply_markup } = buildScanResultMessage(summary);
      await editOrReply(ctx, text, { reply_markup }, { edit });
      return;
    }
    if (view === 'details') {
      await editOrReply(
        ctx,
        formatScanDetails(summary),
        { reply_markup: buildScanDetailsKeyboard(summary) },
        { edit }
      );
      return;
    }
    if (view === 'priority') {
      await editOrReply(
        ctx,
        formatScanPriorityList(summary, { page }),
        { reply_markup: buildScanPriorityKeyboard(summary, { page }) },
        { edit }
      );
      return;
    }
    if (view === 'unread') {
      await editOrReply(
        ctx,
        formatScanUnreadList(summary),
        { reply_markup: buildScanUnreadKeyboard(summary) },
        { edit }
      );
      return;
    }
    if (view === 'room' || view === 'room_details') {
      const rooms = Array.isArray(summary.priorityRooms) ? summary.priorityRooms : [];
      const room = rooms.find((r) => String(r.roomId ?? r.id) === String(roomId)) || {
        roomId,
        guest_name: 'گفتگو',
      };
      const aiAvailable = Boolean(llm);
      await editOrReply(
        ctx,
        formatScanRoomCard(room, { showDetails: view === 'room_details' }),
        { reply_markup: buildScanRoomKeyboard(roomId, { aiAvailable }) },
        { edit }
      );
    }
  }

  async function collectStatus() {
    const pending = pendingCount();
    let queued = 0;
    let running = 0;
    let waitingApproval = 0;
    let lastError = null;
    if (queue) {
      queued = queue.list({ status: 'queued', limit: 50 }).length;
      running = queue.list({ status: 'running', limit: 50 }).length;
      waitingApproval = queue.list({ status: 'waiting_for_approval', limit: 50 }).length;
      try {
        const recent = queue.list({ limit: 15 });
        const failed = recent.find(
          (j) => j.errorCode || j.status === 'failed' || j.status === 'dead_letter'
        );
        if (failed?.errorCode) lastError = String(failed.errorCode);
      } catch {
        /* ignore */
      }
    }

    /** @type {Record<string, unknown>} */
    const card = {
      state: runtime.state,
      startedAt: runtime.startedAt,
      lastCommandAt: runtime.lastCommandAt,
      pendingApprovals: pending,
      queued,
      running,
      waitingApproval,
      karlancerAuth: null,
      lastScanAt: null,
      lastScanUnread: null,
      lastPollAt: null,
      pendingRooms: roomFlows ? roomFlows.roomState.pendingCount() : null,
      pollOk: null,
      db: null,
      worker: null,
      lastError,
      extra: null,
    };

    if (typeof hooks.onStatus === 'function') {
      try {
        const extra = await hooks.onStatus(runtime);
        if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
          if (typeof extra.karlancerAuth === 'boolean') card.karlancerAuth = extra.karlancerAuth;
          if (extra.lastScanAt) card.lastScanAt = String(extra.lastScanAt);
          if (extra.lastScanUnread != null) card.lastScanUnread = extra.lastScanUnread;
          if (extra.lastPollAt) card.lastPollAt = String(extra.lastPollAt);
          if (extra.pendingRooms != null) card.pendingRooms = extra.pendingRooms;
          if (typeof extra.pollOk === 'boolean') card.pollOk = extra.pollOk;
          if (extra.db != null) card.db = String(extra.db);
          if (extra.worker != null) card.worker = String(extra.worker);
          if (extra.lastError) card.lastError = redactString(String(extra.lastError));
          if (extra.extra) card.extra = String(extra.extra);
        } else if (extra) {
          const raw = String(extra);
          const authLine = raw.match(/karlancer_auth:\s*(.+)/i);
          if (authLine) {
            const v = authLine[1].toLowerCase();
            card.karlancerAuth = !(v.includes('missing') || v.includes('no'));
          }
          const dbLine = raw.match(/^db:\s*(.+)$/im);
          if (dbLine) card.db = dbLine[1].trim();
          const workerLine = raw.match(/^worker:\s*(.+)$/im);
          if (workerLine) card.worker = workerLine[1].trim();
          const keep = raw
            .split('\n')
            .filter((l) => {
              const s = l.trim().toLowerCase();
              return (
                s &&
                !s.startsWith('db:') &&
                !s.startsWith('worker:') &&
                !s.startsWith('karlancer_auth:') &&
                !s.startsWith('queue_depth:')
              );
            })
            .join('\n');
          if (keep) card.extra = redactString(keep);
        }
      } catch {
        /* ignore */
      }
    }

    if (roomFlows) {
      const health = roomFlows.roomState.getPollHealth();
      if (health) {
        if (card.lastPollAt == null && health.polledAt) card.lastPollAt = health.polledAt;
        if (card.pollOk == null && typeof health.ok === 'boolean') card.pollOk = health.ok;
      }
      if (card.pendingRooms == null) card.pendingRooms = roomFlows.roomState.pendingCount();
    }

    const lastScan = readLastScanSummary();
    if (lastScan) {
      if (card.lastScanAt == null && lastScan.scannedAt) card.lastScanAt = lastScan.scannedAt;
      if (card.lastScanUnread == null && lastScan.unreadOnPage != null) {
        card.lastScanUnread = lastScan.unreadOnPage;
      }
      if (card.importantChats == null && Array.isArray(lastScan.priorityRooms)) {
        card.importantChats = lastScan.priorityRooms.length;
      }
      if (card.newMessages == null && lastScan.unreadOnPage != null) {
        card.newMessages = lastScan.unreadOnPage;
      }
    }

    if (gate) {
      const s = gate.settings.get();
      card.executionMode = s.mode;
      card.emergencyStop = s.emergencyStop;
      card.toggles = s.toggles;
      card.autoToday = gate.getTodayAutoCounts();
      try {
        const recent = gate.listAudit({ limit: 1 });
        if (recent[0]) {
          let detail = {};
          try {
            detail = JSON.parse(recent[0].detail_json || '{}');
          } catch {
            detail = {};
          }
          card.lastAutoAction = `${recent[0].action} · ${detail.reasonFa || detail.reason || ''}`;
        }
      } catch {
        /* ignore */
      }
    }

    return card;
  }

  async function replyHome(ctx, { edit = false } = {}) {
    const card = await collectStatus();
    const text = formatWelcome({
      karlancerAuth: card.karlancerAuth,
      lastScanAt: card.lastScanAt,
      pendingApprovals: card.pendingApprovals,
      state: card.state,
      pollOk: card.pollOk,
      lastError: card.lastError,
    });
    await editOrReply(ctx, text, { reply_markup: homeInlineKeyboard() }, { edit });
  }

  async function replySystemDetails(ctx, { edit = false } = {}) {
    const card = await collectStatus();
    await editOrReply(
      ctx,
      formatSystemDetails(card),
      { reply_markup: systemDetailsKeyboard() },
      { edit }
    );
  }

  async function replyStatus(ctx, { edit = false } = {}) {
    const card = await collectStatus();
    const text = formatStatusCard(card);
    const reply_markup = statusInlineKeyboard({ pendingCount: card.pendingApprovals });
    await editOrReply(ctx, text, { reply_markup }, { edit });
  }

  async function replySettings(ctx, { edit = false } = {}) {
    const exec = gate ? gate.settings.get() : {};
    const liveAutoBid =
      typeof hooks.getAllowLiveAutoBid === 'function'
        ? Boolean(hooks.getAllowLiveAutoBid())
        : readLiveAutoBidFlag(db, { envDefault: Boolean(hooks.allowLiveAutoBid) });
    let text = formatSettingsCard({
      state: runtime.state,
      karlancerAuth: api?.client ? Boolean(api.client.hasAuth) : null,
      executionMode: exec.mode || 'manual',
      chatAiMode: exec.chatAiMode || 'full_manual',
      emergencyStop: Boolean(exec.emergencyStop),
      toggles: exec.toggles || {},
      liveAutoBid,
    });
    try {
      const th = checkTokenHealth({
        authOk: api?.client ? Boolean(api.client.hasAuth) : null,
        envFile: hooks.envFile || null,
      });
      if (th.ageDays != null) {
        text += `\n• سن تقریبی توکن: ${Math.floor(th.ageDays)} روز`;
      }
      const warn = formatTokenWarningFa(th);
      if (warn) text += `\n\n⚠️ ${warn}`;
      else if (th.healthy === false) {
        text += '\n\n⚠️ نشست نامعتبر — تمدید با توکن مرورگر پیشنهاد می‌شود.';
      }
    } catch {
      /* ignore */
    }
    const reply_markup = settingsInlineKeyboard(runtime.state, {
      mode: exec.mode,
      emergencyStop: Boolean(exec.emergencyStop),
    });
    await editOrReply(ctx, text, { reply_markup }, { edit });
  }

  
  async function replyChatAiMode(ctx, { edit = false } = {}) {
    const exec = gate ? gate.settings.get() : { chatAiMode: 'full_manual' };
    const text = formatChatAiModeCard({
      chatAiMode: exec.chatAiMode || 'full_manual',
      executionMode: exec.mode || 'manual',
      toggles: exec.toggles || {},
      emergencyStop: exec.emergencyStop,
    });
    const extra = { reply_markup: chatAiModeInlineKeyboard(exec.chatAiMode || 'full_manual') };
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, extra);
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(text, { ...menuOpts(), ...extra });
  }

async function replyMode(ctx, { edit = false } = {}) {
    const exec = gate ? gate.settings.get() : { mode: 'manual' };
    await editOrReply(
      ctx,
      formatModeCard({
        executionMode: exec.mode,
        emergencyStop: exec.emergencyStop,
        toggles: exec.toggles || {},
      }),
      { reply_markup: modeInlineKeyboard(exec.mode || 'manual') },
      { edit }
    );
  }

  async function replyRules(ctx, { edit = false } = {}) {
    const exec = gate ? gate.settings.get() : {};
    await editOrReply(
      ctx,
      formatRulesCard(exec),
      { reply_markup: rulesInlineKeyboard() },
      { edit }
    );
  }

  async function replyToggles(ctx, { edit = false } = {}) {
    const exec = gate ? gate.settings.get() : {};
    await editOrReply(
      ctx,
      formatTogglesCard({ ...exec, executionMode: exec.mode }),
      {
        reply_markup: togglesInlineKeyboard(exec.toggles || {}, {
          mode: exec.mode || 'manual',
        }),
      },
      { edit }
    );
  }

  async function replyAutomation(ctx, { edit = false } = {}) {
    const exec = gate ? gate.settings.get() : {};
    const counts = gate ? gate.getTodayAutoCounts() : { messages: 0, bids: 0 };
    const text = [
      formatTogglesCard({ ...exec, executionMode: exec.mode }),
      '',
      formatRulesCard(exec),
      '',
      `امروز: پیام خودکار ${toFaNum(counts.messages)} / ${toFaNum(exec.limits?.maxAutoMessagesPerDay ?? 5)}`,
      `پیشنهاد خودکار ${toFaNum(counts.bids)} / ${toFaNum(exec.limits?.maxAutoBidsPerDay ?? 10)}`,
    ].join('\n');
    await editOrReply(
      ctx,
      text,
      { reply_markup: settingsInlineKeyboard(runtime.state, exec) },
      { edit }
    );
  }

  async function doEmergencyStop(ctx, { edit = false } = {}) {
    if (!gate) {
      await ctx.reply('ذخیره تنظیمات در دسترس نیست.', menuOpts());
      return;
    }
    gate.emergencyStop();
    const text = formatEmergencyCard(true);
    await editOrReply(
      ctx,
      text,
      { reply_markup: settingsInlineKeyboard(runtime.state, { emergencyStop: true }) },
      { edit }
    );
  }

  async function doEmergencyClear(ctx, { edit = false } = {}) {
    if (!gate) {
      await ctx.reply('ذخیره تنظیمات در دسترس نیست.', menuOpts());
      return;
    }
    gate.clearEmergency({ keepManual: true });
    await replySettings(ctx, { edit });
  }

  async function doSetMode(ctx, mode, { edit = false } = {}) {
    if (!gate) {
      await ctx.reply('ذخیره تنظیمات در دسترس نیست.', menuOpts());
      return;
    }
    if (gate.settings.get().emergencyStop && mode !== 'manual') {
      await editOrReply(
        ctx,
        '🛑 اول توقف اضطراری را بردارید، بعد حالت خودکار/کمکی را انتخاب کنید.',
        { reply_markup: settingsInlineKeyboard(runtime.state, { emergencyStop: true }) },
        { edit }
      );
      return;
    }
    gate.settings.setMode(mode);
    await replyMode(ctx, { edit });
  }

  async function doToggle(ctx, name, { edit = false } = {}) {
    if (!gate) {
      await ctx.reply('ذخیره تنظیمات در دسترس نیست.', menuOpts());
      return;
    }
    const cur = gate.settings.get();
    if (cur.emergencyStop) {
      await editOrReply(
        ctx,
        '🛑 توقف اضطراری فعال است — سوئیچ‌ها قفل‌اند.',
        { reply_markup: settingsInlineKeyboard(runtime.state, { emergencyStop: true }) },
        { edit }
      );
      return;
    }
    const currentlyOn = Boolean(cur.toggles?.[name]);
    const highRisk = name === 'autoReplyMessages' || name === 'autoSubmitBids';
    // Enabling high-risk toggles requires explicit confirm (was confusing “نیاز به تأیید”).
    if (highRisk && !currentlyOn) {
      await editOrReply(
        ctx,
        formatToggleConfirmCard(name, {
          executionMode: cur.mode,
          toggles: cur.toggles,
        }),
        {
          reply_markup: toggleConfirmKeyboard(name, {
            offerModeAuto: cur.mode !== 'auto',
          }),
        },
        { edit }
      );
      return;
    }
    gate.settings.setToggle(name, !currentlyOn);
    await replyToggles(ctx, { edit });
  }

  async function doToggleConfirm(ctx, name, { alsoModeAuto = false, edit = false } = {}) {
    if (!gate) {
      await ctx.reply('ذخیره تنظیمات در دسترس نیست.', menuOpts());
      return;
    }
    const cur = gate.settings.get();
    if (cur.emergencyStop) {
      await editOrReply(
        ctx,
        '🛑 توقف اضطراری فعال است — سوئیچ‌ها قفل‌اند.',
        { reply_markup: settingsInlineKeyboard(runtime.state, { emergencyStop: true }) },
        { edit }
      );
      return;
    }
    if (alsoModeAuto && cur.mode !== 'auto') {
      gate.settings.setMode('auto');
    }
    gate.settings.setToggle(name, true);
    await replyToggles(ctx, { edit });
  }

  async function doRuleToggle(ctx, kind, { edit = false } = {}) {
    if (!gate) {
      await ctx.reply('ذخیره تنظیمات در دسترس نیست.', menuOpts());
      return;
    }
    const cur = gate.settings.get();
    if (kind === 'message') {
      const enabled = !cur.rules.messageAuto.enabled;
      gate.settings.update({
        rules: { messageAuto: { ...cur.rules.messageAuto, enabled } },
      });
    } else if (kind === 'bid') {
      const enabled = !cur.rules.bidAuto.enabled;
      gate.settings.update({
        rules: { bidAuto: { ...cur.rules.bidAuto, enabled } },
      });
    }
    await replyRules(ctx, { edit });
  }

  async function startReloginFlow(ctx, { edit = false } = {}) {
    beginRelogin(ctx.chat.id);
    const text = RELOGIN_MSG.ASK_CHOICE;
    const reply_markup = reloginChoiceKeyboard();
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { reply_markup });
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(text, { reply_markup });
  }

  async function startTokenPasteFlow(ctx, { edit = false } = {}) {
    beginTokenPaste(ctx.chat.id);
    const text = RELOGIN_MSG.ASK_TOKEN;
    const reply_markup = reloginCancelKeyboard();
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { reply_markup });
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(text, { reply_markup });
  }

  async function startPasswordFallbackFlow(ctx, { edit = false } = {}) {
    beginPasswordFallback(ctx.chat.id);
    const text = RELOGIN_MSG.ASK_PHONE;
    const reply_markup = reloginCancelKeyboard();
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { reply_markup });
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(text, { reply_markup });
  }

  async function replyPostWin(ctx, { edit = false } = {}) {
    let state = null;
    try {
      if (api?.notifications?.list) {
        const listed = await api.notifications.list({ page: 1 });
        const { wins } = scanNotificationsForWins(listed.notifications || []);
        if (wins[0]) {
          state = advancePostWin(wins[0].state, {
            projectTitle: wins[0].notification?.title,
          });
        }
      }
    } catch {
      /* soft — show empty scaffold */
    }
    const text = formatPostWinSectionFa(state);
    await editOrReply(
      ctx,
      text,
      { reply_markup: settingsInlineKeyboard(runtime.state, gate ? gate.settings.get() : {}) },
      { edit }
    );
  }

  async function replyHelp(ctx, { edit = false } = {}) {
    await editOrReply(
      ctx,
      formatHelp(),
      {
        reply_markup: homeInlineKeyboard(),
      },
      { edit }
    );
  }

  async function replyApprovals(ctx, { edit = false } = {}) {
    if (!queue) {
      const { text, keyboard } = formatFriendlyError('صف عملیات وصل نیست.', {
        retryCallback: 'goto:approvals',
      });
      await editOrReply(ctx, text, { reply_markup: keyboard }, { edit });
      return;
    }
    const pending = queue.pendingApprovals();
    const { text, keyboards } = formatApprovalsList(pending);
    if (!pending.length) {
      await editOrReply(
        ctx,
        text,
        { reply_markup: statusInlineKeyboard({ pendingCount: 0 }) },
        { edit }
      );
      return;
    }
    const firstKb = keyboards[0];
    const a = pending[0];
    const summary = [
      `✅ تأییدهای در انتظار (${toFaNum(pending.length)})`,
      '',
      formatApprovalDetail(a),
      pending.length > 1 ? '\nبقیه موارد در پیام‌های بعدی.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    await editOrReply(ctx, summary, { reply_markup: firstKb }, { edit });
    for (let i = 1; i < Math.min(pending.length, 8); i++) {
      const item = pending[i];
      await ctx.reply(formatApprovalDetail(item), {
        reply_markup: approvalActionKeyboard(item.approval_id),
      });
    }
  }

  async function doPause(ctx, { edit = false } = {}) {
    runtime.state = 'paused';
    if (edit) {
      await replySettings(ctx, { edit: true });
      return;
    }
    await ctx.reply('⏸ ایجنت روی مکث است. از تنظیمات «ادامه» را بزنید.', menuOpts());
  }

  async function doResume(ctx, { edit = false } = {}) {
    runtime.state = 'running';
    if (edit) {
      await replySettings(ctx, { edit: true });
      return;
    }
    await ctx.reply('▶️ ایجنت دوباره فعال است.', menuOpts());
  }

  async function doScan(ctx, { edit = false, page = 1 } = {}) {
    if (!queue) {
      const { text, keyboard } = formatFriendlyError('صف عملیات وصل نیست.', {
        retryCallback: 'set:scan',
      });
      await editOrReply(ctx, text, { reply_markup: keyboard }, { edit });
      return;
    }
    if (runtime.state === 'paused') {
      await editOrReply(
        ctx,
        'ایجنت روی مکث است — اول از تنظیمات «ادامه» را بزنید.',
        { reply_markup: settingsInlineKeyboard('paused') },
        { edit }
      );
      return;
    }
    const active = findActiveScanJob(queue);
    if (active) {
      const text = formatScanAlreadyRunning({ jobId: active.jobId });
      const sent = await editOrReply(
        ctx,
        text,
        { reply_markup: buildScanKeyboard({ alreadyRunning: true, jobId: active.jobId }) },
        { edit }
      );
      if (sent?.messageId != null) {
        setPendingScanMessage({ chatId: sent.chatId, messageId: sent.messageId, jobId: active.jobId });
      }
      return;
    }
    const job = queue.create({
      goal: 'rooms.scan',
      requestedBy: `telegram:${ctx.from?.id}`,
      payload: { page, manual: true, forceNotify: true },
    });
    const sent = await editOrReply(
      ctx,
      formatScanQueued(job.jobId),
      { reply_markup: buildScanKeyboard({ loading: true, jobId: job.jobId }) },
      { edit }
    );
    if (sent?.messageId != null) {
      setPendingScanMessage({ chatId: sent.chatId, messageId: sent.messageId, jobId: job.jobId });
    }
  }

  /** One-tap «تحلیل همه» — enqueue rooms.prepare_scan from last priorities. */
  async function doPrepareScan(ctx, { edit = false } = {}) {
    if (!queue) {
      const { text, keyboard } = formatFriendlyError('صف عملیات وصل نیست.', {
        retryCallback: 'scan:prepare',
      });
      await editOrReply(ctx, text, { reply_markup: keyboard }, { edit });
      return;
    }
    if (runtime.state === 'paused') {
      await editOrReply(
        ctx,
        'ایجنت روی مکث است — اول از تنظیمات «ادامه» را بزنید.',
        { reply_markup: settingsInlineKeyboard('paused') },
        { edit }
      );
      return;
    }
    const job = queue.create({
      goal: 'rooms.prepare_scan',
      requestedBy: `telegram:${ctx.from?.id}`,
      payload: { forcePrepare: true },
    });
    const sent = await editOrReply(
      ctx,
      [
        '🤖 در حال تحلیل اولویت‌ها…',
        '————————',
        '',
        'پیش‌نویس پاسخ/پیشنهاد ساخته می‌شود و برای تأیید شما در «تأییدها» می‌آید.',
        'ارسال زنده انجام نمی‌شود تا خودتان تأیید کنید.',
      ].join('\n'),
      { reply_markup: buildScanKeyboard({ loading: true, jobId: job.jobId }) },
      { edit }
    );
    if (sent?.messageId != null) {
      setPendingScanMessage({ chatId: sent.chatId, messageId: sent.messageId, jobId: job.jobId });
    }
  }

  async function decide(ctx, approve, approvalIdHint) {
    if (!queue) {
      return { ok: false, text: 'صف عملیات وصل نیست.' };
    }
    const arg =
      approvalIdHint ||
      ctx.match?.trim?.() ||
      (ctx.message?.text || '').split(/\s+/).slice(1).join(' ').trim();
    let approval = null;
    const pending = queue.pendingApprovals();
    if (arg) {
      approval = pending.find((a) => a.approval_id === arg || a.approval_id.startsWith(arg));
    } else {
      approval = pending[0];
    }
    if (!approval) {
      return { ok: false, text: 'تأییدی پیدا نشد. از «تأییدها» ببینید.' };
    }
    const result = queue.decideApproval(approval.approval_id, {
      approve,
      decidedBy: `telegram:${ctx.from?.id}`,
    });
    let note = null;
    if (result?.tampered) note = '⚠️ payload مشکوک — تأیید اعمال نشد';
    else if (result?.expired) note = 'منقضی شده بود';
    else if (result?.alreadyDecided) note = 'قبلاً تصمیم‌گیری شده';
    return {
      ok: true,
      text: formatDecideResult({
        approve,
        approvalId: approval.approval_id,
        jobStatus: result?.job?.status,
        note,
      }),
      result,
      approval,
    };
  }

  // —— Commands ——
  bot.command('start', async (ctx) => {
    touch();
    const chatId = ctx.chat?.id;
    if (!isOwner(ctx)) {
      await ctx.reply(
        `سلام 👋\nchat id شما: \`${chatId}\`\n\nاگر owner هستید این مقدار را در TELEGRAM_OWNER_CHAT_ID تنظیم کنید، سپس npm start.`
      );
      return;
    }
    await replyHome(ctx);
  });

  bot.command('help', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyHelp(ctx);
  });

  bot.command('settings', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replySettings(ctx);
  });

  bot.command('control', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await control.replyHub(ctx);
  });

  bot.command('mode', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyMode(ctx);
  });

  bot.command('opportunities', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyOpportunitiesHub(ctx);
  });

  bot.command('show_rules', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyRules(ctx);
  });

  bot.command('automation', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyAutomation(ctx);
  });

  bot.command('emergency_stop', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await doEmergencyStop(ctx);
  });

  bot.command('status', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyStatus(ctx);
  });

  bot.command('pause', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await doPause(ctx);
  });

  bot.command('resume', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await doResume(ctx);
  });

  bot.command('approvals', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyApprovals(ctx);
  });

  bot.command('approve', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    const out = await decide(ctx, true);
    await ctx.reply(out?.text || 'خطا', menuOpts());
  });

  bot.command('reject', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    const out = await decide(ctx, false);
    await ctx.reply(out?.text || 'خطا', menuOpts());
  });

  bot.command('scan', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await doScan(ctx);
  });

  bot.command('chats', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (!roomFlows) {
      await ctx.reply('گفتگوها در دسترس نیست (db).', menuOpts());
      return;
    }
    await roomFlows.replyRoomsList(ctx, { unreadOnly: false });
  });

  bot.command('unread', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (!roomFlows) {
      await ctx.reply('مهم‌ها در دسترس نیست (db).', menuOpts());
      return;
    }
    await roomFlows.replyRoomsList(ctx, { unreadOnly: true });
  });

  bot.command('cancel', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (roomFlows) roomFlows.roomState.clearAwaitingNote(ctx.from?.id);
    if (wizard) wizard.clear(ctx.from?.id);
    if (getReloginState(ctx.chat?.id)) {
      clearReloginState(ctx.chat.id);
      await ctx.reply(RELOGIN_MSG.CANCELLED, menuOpts());
      return;
    }
    await ctx.reply('لغو شد.', menuOpts());
  });

  bot.command('opportunities', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyOpportunitiesHub(ctx);
  });

  bot.command('inbox', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await replyDecisionInbox(ctx);
  });

  // —— Reply keyboard text map ——
  bot.on('message:text', async (ctx, next) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (roomFlows && (await roomFlows.maybeHandleAwaitingNote(ctx))) return;

    if (wizard && (await maybeHandleWizardText(ctx))) return;

    if (getReloginState(ctx.chat?.id)) {
      await handleReloginText({
        ctx,
        api,
        envFile: hooks.envFile,
        logInfo: (msg, fields) => {
          try {
            console.log(JSON.stringify({ level: 'info', msg, ...(fields || {}) }));
          } catch {
            /* ignore */
          }
        },
        logWarn: (msg, fields) => {
          try {
            console.warn(JSON.stringify({ level: 'warn', msg, ...(fields || {}) }));
          } catch {
            /* ignore */
          }
        },
      });
      return;
    }

    const action = mapMenuText(ctx.message.text);
    if (!action) return next();
    if (action === 'dashboard' || action === 'status') return replyStatus(ctx);
    if (action === 'approvals') return replyApprovals(ctx);
    if (action === 'opportunities') return replyOpportunitiesHub(ctx);
    if (action === 'inbox') return replyDecisionInbox(ctx);
    if (action === 'answered') {
      if (!roomFlows) return ctx.reply('در دسترس نیست.', menuOpts());
      return roomFlows.replyAnsweredList(ctx);
    }
    if (action === 'chats') {
      if (!roomFlows) return ctx.reply('گفتگوها در دسترس نیست.', menuOpts());
      return roomFlows.replyRoomsList(ctx, { unreadOnly: false });
    }
    if (action === 'alerts' || action === 'unread') {
      if (!roomFlows) return ctx.reply('مهم‌ها در دسترس نیست.', menuOpts());
      return roomFlows.replyRoomsList(ctx, { unreadOnly: true });
    }
    if (action === 'settings') return replySettings(ctx);
    if (action === 'control') return control.replyHub(ctx);
    if (action === 'scan') return doScan(ctx);
    if (action === 'pause') return doPause(ctx);
    if (action === 'resume') return doResume(ctx);
    if (action === 'help') return replyHelp(ctx);
  });


  function resolveLiveAutoBid() {
    if (typeof hooks.getAllowLiveAutoBid === 'function') {
      return Boolean(hooks.getAllowLiveAutoBid());
    }
    return readLiveAutoBidFlag(db, { envDefault: Boolean(hooks.allowLiveAutoBid) });
  }

  function getOppScanner(notifyFn = null) {
    if (!db || !api) return null;
    return createOpportunityScanner({
      db,
      api,
      mutations,
      tenantId: 'default',
      notify: notifyFn,
      allowLiveAutoBid: resolveLiveAutoBid(),
    });
  }

  async function replyOpportunitiesHub(ctx, { edit = false } = {}) {
    if (!db) {
      await ctx.reply('ذخیره فرصت‌ها در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const list = store.list({ limit: 20 });
    const scan = store.getScanState();
    const profile = store.getScoringProfile();
    const textOut = formatOpportunitiesHub({
      count: list.length,
      lastScanAt: scan.lastScanAt,
      scoringAvailable: isScoringConfigured(profile),
    });
    await editOrReply(
      ctx,
      textOut,
      { reply_markup: opportunitiesListKeyboard(list) },
      { edit }
    );
  }


  async function replyOpportunityBook(ctx, { edit = false } = {}) {
    if (!db) {
      await ctx.reply('کتاب فرصت‌ها در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const threshold = store.getHighScoreThreshold();
    const textOut = formatBookHome({
      total: store.countOpportunities(),
      newCount: store.countNewOpportunities({ withinHours: BOOK_NEW_WITHIN_HOURS }),
      highCount: store.countHighScore({ minScore: threshold }),
      highScoreThreshold: threshold,
      draftCount: store.countDrafts({ status: 'pending' }),
      actionCount: store.countActions(),
      scanCount: store.countScanRuns(),
    });
    await editOrReply(ctx, textOut, { reply_markup: bookHomeKeyboard() }, { edit });
  }

  async function replyBookSection(ctx, section, page = 0, { edit = true, scanId = null } = {}) {
    if (!db) {
      await ctx.reply('کتاب فرصت‌ها در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const safePage = Math.max(0, Number(page) || 0);
    const limit = BOOK_PAGE_SIZE;
    const offset = safePage * limit;

    if (section === 'new') {
      const total = store.countNewOpportunities({ withinHours: BOOK_NEW_WITHIN_HOURS });
      const items = store.listNewOpportunities({
        withinHours: BOOK_NEW_WITHIN_HOURS,
        limit,
        offset,
      });
      await editOrReply(
        ctx,
        formatBookOppList({
          title: '🆕 جدیدها',
          items,
          total,
          page: safePage,
          emptyKey: 'new',
        }),
        { reply_markup: bookOppListKeyboard(items, { prefix: 'book:new', page: safePage, total }) },
        { edit }
      );
      return;
    }
    if (section === 'high') {
      const threshold = store.getHighScoreThreshold();
      const total = store.countHighScore({ minScore: threshold });
      const items = store.listHighScore({ minScore: threshold, limit, offset });
      await editOrReply(
        ctx,
        formatBookOppList({
          title: `⭐ امتیاز بالا (≥ ${threshold})`,
          items,
          total,
          page: safePage,
          emptyKey: 'high',
        }),
        { reply_markup: bookOppListKeyboard(items, { prefix: 'book:hi', page: safePage, total }) },
        { edit }
      );
      return;
    }
    if (section === 'all') {
      const total = store.countOpportunities();
      const items = store.list({ limit, offset, orderBy: 'last_seen' });
      await editOrReply(
        ctx,
        formatBookOppList({
          title: '📋 همه فرصت‌ها',
          items,
          total,
          page: safePage,
          emptyKey: 'all',
        }),
        { reply_markup: bookOppListKeyboard(items, { prefix: 'book:all', page: safePage, total }) },
        { edit }
      );
      return;
    }
    if (section === 'drafts') {
      const total = store.countDrafts({ status: 'pending' });
      const drafts = store.listDrafts({ status: 'pending', limit, offset });
      const oppsById = {};
      for (const d of drafts) {
        const row = store.get(d.oppId);
        if (row) oppsById[d.oppId] = row;
      }
      await editOrReply(
        ctx,
        formatBookDrafts(drafts, oppsById, { total, page: safePage }),
        { reply_markup: bookDraftsKeyboard(drafts, { page: safePage, total }) },
        { edit }
      );
      return;
    }
    if (section === 'actions') {
      const total = store.countActions();
      const actions = store.listActions({ limit, offset });
      await editOrReply(
        ctx,
        formatBookActions(actions, { total, page: safePage }),
        { reply_markup: bookActionsKeyboard(actions, { page: safePage, total }) },
        { edit }
      );
      return;
    }
    if (section === 'scans') {
      const total = store.countScanRuns();
      const runs = store.listScanRuns({ limit, offset });
      await editOrReply(
        ctx,
        formatBookScans(runs, { total, page: safePage }),
        { reply_markup: bookScansKeyboard(runs, { page: safePage, total }) },
        { edit }
      );
      return;
    }
    if (section === 'scan_run' && scanId) {
      const run = store.getScanRun(scanId);
      if (!run) {
        await editOrReply(
          ctx,
          'اسکن پیدا نشد.',
          { reply_markup: bookHomeKeyboard() },
          { edit }
        );
        return;
      }
      const items = store.listOpportunitiesForScanRun(scanId, { limit, offset });
      await editOrReply(
        ctx,
        formatBookScanRun(run, items, { page: safePage }),
        { reply_markup: bookScanRunKeyboard(run, items, { page: safePage }) },
        { edit }
      );
      return;
    }
    await replyOpportunityBook(ctx, { edit });
  }

  async function replyBookOpp(ctx, oppId, { edit = true } = {}) {
    if (!db) return;
    const store = createOpportunityStore(db);
    const row = store.get(oppId);
    if (!row) {
      await editOrReply(ctx, 'فرصت پیدا نشد.', { reply_markup: bookHomeKeyboard() }, { edit });
      return;
    }
    await editOrReply(
      ctx,
      formatBookOppDetail(row),
      { reply_markup: bookOppDetailKeyboard(row.id) },
      { edit }
    );
  }

  async function replyBookDraft(ctx, draftId, { edit = true } = {}) {
    if (!db) return;
    const store = createOpportunityStore(db);
    const draft = store.getDraft(draftId);
    if (!draft) {
      await editOrReply(ctx, 'پیش‌نویس پیدا نشد.', { reply_markup: bookHomeKeyboard() }, { edit });
      return;
    }
    const opp = store.get(draft.oppId);
    await editOrReply(
      ctx,
      formatBookDraftDetail(draft, opp),
      { reply_markup: bookDraftDetailKeyboard(draft) },
      { edit }
    );
  }

    async function replyDecisionInbox(ctx, { edit = false } = {}) {
    if (!db) {
      await ctx.reply('صندوق در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const opps = store.list({ minScore: 40, limit: 10 }).filter((o) => o.state !== 'IGNORED');
    const approvals = queue ? queue.pendingApprovals() : [];
    const approvalLabels = approvals.map((a) => ({
      approval_id: a.approval_id,
      action: a.action,
      label: `${a.action || 'عملیات'} · ${String(a.approval_id || '').slice(0, 8)}`,
    }));
    let messages = [];
    try {
      const ids = roomFlows?.roomState?.listPendingRoomIds?.() || [];
      messages = ids.slice(0, 5).map((id) => ({
        roomId: id,
        label: `گفتگو ${id}`,
      }));
    } catch {
      messages = [];
    }
    const textOut = formatDecisionInbox({
      opportunities: opps,
      approvals: approvalLabels,
      messages,
    });
    await editOrReply(ctx, textOut, { reply_markup: decisionInboxKeyboard() }, { edit });
  }

  async function replyScoringProfile(ctx, { edit = false } = {}) {
    if (!db) {
      await ctx.reply('پروفایل در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const profile = store.getScoringProfile();
    await editOrReply(
      ctx,
      formatScoringProfile(profile),
      { reply_markup: scoringProfileKeyboard(profile) },
      { edit }
    );
  }

  async function doOpportunityScan(ctx, { edit = false } = {}) {
    const scanner = getOppScanner(async (textMsg, meta) => {
      try {
        const opp = meta?.opportunity;
        await ctx.api.sendMessage(ctx.chat.id, textMsg, {
          reply_markup: opp?.id ? opportunityCardKeyboard(opp.id) : undefined,
        });
      } catch {
        /* ignore notify errors */
      }
    });
    if (!scanner) {
      await ctx.reply('اسکنر فرصت آماده نیست.', menuOpts());
      return;
    }
    await editOrReply(ctx, '🔍 در حال اسکن فرصت‌ها…', {}, { edit });
    const out = await scanner.scan({ manual: true, pages: 1, includeInvites: true });
    await editOrReply(
      ctx,
      formatOpportunityScanResult(out),
      { reply_markup: opportunityScanResultKeyboard(out) },
      { edit: true }
    );
  }

  async function replyOpportunityRules(ctx, { edit = false } = {}) {
    if (!db) {
      await ctx.reply('قوانین در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const rules = store.listRules();
    const lines = ['📜 قوانین فرصت', '————————', ''];
    if (!rules.length) {
      lines.push('هنوز قانونی نیست. «قانون جدید» یا «نمونه» را بزنید.');
    } else {
      for (const r of rules.slice(0, 15)) {
        lines.push(`${r.enabled ? '✅' : '⛔'} ${r.name} → ${r.action}`);
      }
    }
    await editOrReply(
      ctx,
      lines.join('\n'),
      { reply_markup: opportunityRulesKeyboard(rules) },
      { edit }
    );
  }

  async function showSmartBid(ctx, projectId, { edit = true } = {}) {
    const store = createOpportunityStore(db);
    const row = store.get(projectId);
    if (!row) {
      await editOrReply(ctx, 'فرصت پیدا نشد.', { reply_markup: opportunitiesListKeyboard([]) }, { edit });
      return;
    }
    const profile = store.getScoringProfile();
    const opp = row.opportunity || row;
    const smart = buildSmartBid(opp, profile, {
      score: row.score,
      reasons: row.scoreReasons || [],
    });
    // stash last smart bid for edit/submit
    if (wizard) {
      wizard.set(ctx.from?.id, {
        kind: 'smart_bid_ready',
        projectId: String(projectId),
        text: smart.text,
        price: smart.price,
        days: smart.days,
      });
    }
    try {
      store.upsertDraft({
        oppId: String(projectId),
        body: smart.text,
        suggestedPrice: smart.price ?? null,
        suggestedDays: smart.days ?? 7,
        status: 'pending',
      });
      store.recordAction({
        type: 'draft_prepared',
        oppId: String(projectId),
        note: 'پیش‌نویس از تلگرام',
        preview: String(smart.text || '').slice(0, 200),
      });
    } catch {
      /* ignore */
    }
    await editOrReply(ctx, smart.previewFa, { reply_markup: smartBidKeyboard(projectId) }, { edit });
  }

  async function requestSmartBidApproval(ctx, projectId) {
    if (!mutations) {
      await ctx.reply('صف جهش در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const row = store.get(projectId);
    if (!row) {
      await ctx.reply('فرصت پیدا نشد.', menuOpts());
      return;
    }
    const profile = store.getScoringProfile();
    const wz = wizard?.get(ctx.from?.id);
    const smart =
      wz?.kind === 'smart_bid_ready' && wz.projectId === String(projectId)
        ? { text: wz.text, price: wz.price, days: wz.days }
        : buildSmartBid(row.opportunity || row, profile, { score: row.score });
    const result = mutations.request({
      action: 'bids.submit',
      payload: {
        projectId,
        proposalText: smart.text,
        price: smart.price ?? row.budgetMin ?? 1_000_000,
        days: smart.days ?? 7,
        smartBid: true,
        opportunityScore: row.score,
      },
      gateCtx: {
        source: 'telegram',
        projectId,
        matchScore: row.score,
        confidence: row.score,
        budget: row.budgetMax ?? row.budgetMin,
        category: row.category,
        hasExistingBid: false,
        riskHint: 'high',
      },
      requestedBy: `telegram:${ctx.from?.id}`,
      targetRef: String(projectId),
      forceRequireApproval: true,
      idempotencyKey: `smart-bid:${projectId}:${Date.now()}`,
    });
    store.setState(projectId, 'ACTION_CREATED');
    try {
      store.upsertDraft({
        oppId: projectId,
        body: smart.text,
        suggestedPrice: smart.price ?? row.budgetMin ?? null,
        suggestedDays: smart.days ?? 7,
        status: 'pending',
      });
      store.recordAction({
        type: 'sent_to_approvals',
        oppId: projectId,
        note: 'بفرست تأییدها',
        preview: row.title || null,
      });
    } catch {
      /* ignore */
    }
    if (wizard) wizard.clear(ctx.from?.id);
    if (result.denied) {
      await editOrReply(
        ctx,
        `⛔ گیت رد کرد: ${result.verdict?.reasonFa || result.verdict?.reason || 'deny'}`,
        { reply_markup: opportunityCardKeyboard(projectId) },
        { edit: true }
      );
      return;
    }
    await editOrReply(
      ctx,
      [
        '✅ پیشنهاد هوشمند در صف تأیید قرار گرفت.',
        'از «✅ تأییدها» یا صندوق تصمیم می‌توانید اجرا/رد کنید.',
        'ارسال زنده فقط پس از تأیید و VerifiedMutationContract.',
      ].join('\n'),
      { reply_markup: opportunityCardKeyboard(projectId) },
      { edit: true }
    );
  }

  /**
   * Batch-prepare smart bids into HITL approvals (capped). Never live-sends.
   * Includes NOTIFY-tier so owner can one-tap draft → تأییدها.
   */
  async function prepMatchedOpportunities(ctx) {
    if (!mutations) {
      await ctx.reply('صف جهش در دسترس نیست.', menuOpts());
      return;
    }
    const store = createOpportunityStore(db);
    const rows = store
      .list({ limit: 40 })
      .filter((r) => {
        if (!r || r.state === 'IGNORED' || r.state === 'SUBMITTED') return false;
        const d = r.decision;
        if (d === 'IGNORE') return false;
        return (
          d === 'NOTIFY' ||
          d === 'CREATE_DRAFT' ||
          d === 'REQUEST_APPROVAL' ||
          Number(r.score || 0) >= 40
        );
      })
      .slice(0, OPP_BATCH_PREP_CAP);

    if (!rows.length) {
      await editOrReply(
        ctx,
        [
          'مورد منطبق/قابل پیش‌نویس برای آماده‌سازی نیست.',
          'از «🔥 فرصت‌ها» یک کارت را دستی باز کنید.',
        ].join('\n'),
        { reply_markup: opportunityScanResultKeyboard({}) },
        { edit: true }
      );
      return;
    }

    const profile = store.getScoringProfile();
    let prepared = 0;
    let denied = 0;
    for (const row of rows) {
      const smart = buildSmartBid(row.opportunity || row, profile, { score: row.score });
      try {
        const result = mutations.request({
          action: 'bids.submit',
          payload: {
            projectId: row.id,
            proposalText: smart.text,
            price: smart.price ?? row.budgetMin ?? 1_000_000,
            days: smart.days ?? 7,
            smartBid: true,
            opportunityScore: row.score,
            fromBatchPrep: true,
          },
          gateCtx: {
            source: 'telegram',
            projectId: row.id,
            matchScore: row.score,
            confidence: row.score,
            budget: row.budgetMax ?? row.budgetMin,
            category: row.category,
            hasExistingBid: false,
            riskHint: 'high',
          },
          requestedBy: `telegram:${ctx.from?.id}`,
          targetRef: String(row.id),
          forceRequireApproval: true,
          idempotencyKey: `opp-batch-prep:${row.id}`,
        });
        if (result?.denied) denied += 1;
        else {
          prepared += 1;
          store.setState(row.id, 'ACTION_CREATED');
        }
      } catch {
        denied += 1;
      }
    }

    await editOrReply(
      ctx,
      [
        '📝 پیش‌نویس گروهی',
        '————————',
        `${prepared} مورد به «تأییدها» اضافه شد (سقف ${OPP_BATCH_PREP_CAP}).`,
        denied ? `${denied} مورد رد/ناموفق بود.` : null,
        'ارسال زنده فقط پس از تأیید شما انجام می‌شود.',
      ]
        .filter(Boolean)
        .join('\n'),
      { reply_markup: decisionInboxKeyboard() },
      { edit: true }
    );
  }

  controlBridges.replyOpportunitiesHub = replyOpportunitiesHub;
  controlBridges.replyOpportunityBook = replyOpportunityBook;
  controlBridges.replyOpportunityRules = replyOpportunityRules;
  controlBridges.replyScoringProfile = replyScoringProfile;
  controlBridges.doOpportunityScan = doOpportunityScan;
  controlBridges.replyPostWin = replyPostWin;

  async function maybeHandleWizardText(ctx) {
    if (!wizard || !db) return false;
    if (await control.handleWizardText(ctx)) return true;
    const st = wizard.get(ctx.from?.id);
    if (!st?.kind) return false;
    const textIn = (ctx.message?.text || '').trim();
    if (!textIn) return false;
    if (textIn === '/cancel') {
      wizard.clear(ctx.from?.id);
      await ctx.reply('لغو شد.', menuOpts());
      return true;
    }
    const store = createOpportunityStore(db);

    if (st.kind === 'profile_skills') {
      const skills = textIn.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
      const cur = store.getScoringProfile();
      store.setScoringProfile({ ...cur, preferredSkills: skills });
      getOppScanner()?.syncScoringAvailable?.();
      wizard.clear(ctx.from?.id);
      await ctx.reply(`✅ مهارت‌ها ذخیره شد (${skills.length}).`, menuOpts());
      await replyScoringProfile(ctx);
      return true;
    }
    if (st.kind === 'profile_budget') {
      const nums = textIn.replace(/,/g, '').match(/\d+/g) || [];
      const cur = store.getScoringProfile();
      const budgetMin = nums[0] != null ? Number(nums[0]) : null;
      const budgetMax = nums[1] != null ? Number(nums[1]) : null;
      store.setScoringProfile({ ...cur, budgetMin, budgetMax });
      getOppScanner()?.syncScoringAvailable?.();
      wizard.clear(ctx.from?.id);
      await ctx.reply('✅ بودجه ذخیره شد.', menuOpts());
      await replyScoringProfile(ctx);
      return true;
    }
    if (st.kind === 'profile_cats') {
      const cats = textIn.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
      const cur = store.getScoringProfile();
      store.setScoringProfile({ ...cur, preferredCategories: cats });
      getOppScanner()?.syncScoringAvailable?.();
      wizard.clear(ctx.from?.id);
      await ctx.reply(`✅ دسته‌ها ذخیره شد (${cats.length}).`, menuOpts());
      await replyScoringProfile(ctx);
      return true;
    }
    if (st.kind === 'rule_create') {
      const parsed = parseRuleCreateText(textIn);
      if (!parsed.ok) {
        await ctx.reply('قالب نادرست است. دوباره بفرستید یا /cancel', menuOpts());
        return true;
      }
      store.createRule(parsed.rule);
      wizard.clear(ctx.from?.id);
      await ctx.reply(`✅ قانون «${parsed.rule.name}» ساخته شد.`, menuOpts());
      await replyOpportunityRules(ctx);
      return true;
    }
    if (st.kind === 'rule_edit' && st.ruleId) {
      const parsed = parseRuleCreateText(textIn);
      if (!parsed.ok) {
        await ctx.reply('قالب نادرست است. دوباره بفرستید یا /cancel', menuOpts());
        return true;
      }
      store.updateRule(st.ruleId, {
        name: parsed.rule.name,
        conditions: parsed.rule.conditions,
        action: parsed.rule.action,
      });
      wizard.clear(ctx.from?.id);
      await ctx.reply('✅ قانون به‌روز شد.', menuOpts());
      await replyOpportunityRules(ctx);
      return true;
    }
    if (st.kind === 'smart_bid_edit' && st.projectId) {
      wizard.set(ctx.from?.id, {
        kind: 'smart_bid_ready',
        projectId: st.projectId,
        text: textIn.slice(0, 3500),
        price: st.price,
        days: st.days,
      });
      await ctx.reply('✅ متن پیشنهاد به‌روز شد. برای ارسال به صف تأیید دکمه را بزنید.', {
        reply_markup: smartBidKeyboard(st.projectId),
        ...menuOpts(),
      });
      return true;
    }
    return false;
  }

  // —— Inline callbacks ——
  bot.on('callback_query:data', async (ctx) => {
    if (await denyIfNotOwner(ctx, { asCallback: true })) return;
    touch();
    const rawCb = ctx.callbackQuery.data;
    // Control panel + wizards (also handles hands:live:ask)
    if (
      rawCb === 'hands:live:ask' ||
      (typeof rawCb === 'string' &&
        (rawCb.startsWith('cp:') ||
          rawCb.startsWith('eyes:') ||
          rawCb.startsWith('brain:') ||
          rawCb.startsWith('hands:') ||
          rawCb.startsWith('notif:') ||
          rawCb.startsWith('wiz:')))
    ) {
      const cpParsed = parseCallbackData(rawCb) || { type: null };
      if (await control.handleCallback(ctx, cpParsed)) return;
    }

    const parsed = parseCallbackData(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: 'دکمه نامعتبر' });
      return;
    }

    if (parsed.type === 'refresh_status' || parsed.type === 'nav_dash') {
      await ctx.answerCallbackQuery({ text: 'داشبورد…' });
      await replyStatus(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'dash_details') {
      await ctx.answerCallbackQuery({ text: 'جزئیات…' });
      await replySystemDetails(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'nav_home') {
      await ctx.answerCallbackQuery();
      await replyHome(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'nav_settings') {
      await ctx.answerCallbackQuery();
      await replySettings(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'nav_mode') {
      await ctx.answerCallbackQuery();
      await replyMode(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'opp_hub') {
      await ctx.answerCallbackQuery();
      await replyOpportunitiesHub(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'goto_inbox' || parsed.type === 'inbox_refresh') {
      await ctx.answerCallbackQuery();
      await replyDecisionInbox(ctx, { edit: true });
      return;
    }

    const bookCb = parseBookCallback(ctx.callbackQuery.data);
    if (bookCb) {
      await ctx.answerCallbackQuery();
      if (bookCb.type === 'book_home') {
        await replyOpportunityBook(ctx, { edit: true });
        return;
      }
      if (bookCb.type === 'book_new') {
        await replyBookSection(ctx, 'new', bookCb.page, { edit: true });
        return;
      }
      if (bookCb.type === 'book_high') {
        await replyBookSection(ctx, 'high', bookCb.page, { edit: true });
        return;
      }
      if (bookCb.type === 'book_drafts') {
        await replyBookSection(ctx, 'drafts', bookCb.page, { edit: true });
        return;
      }
      if (bookCb.type === 'book_actions') {
        await replyBookSection(ctx, 'actions', bookCb.page, { edit: true });
        return;
      }
      if (bookCb.type === 'book_scans') {
        await replyBookSection(ctx, 'scans', bookCb.page, { edit: true });
        return;
      }
      if (bookCb.type === 'book_all') {
        await replyBookSection(ctx, 'all', bookCb.page, { edit: true });
        return;
      }
      if (bookCb.type === 'book_scan_run') {
        await replyBookSection(ctx, 'scan_run', bookCb.page, {
          edit: true,
          scanId: bookCb.scanId,
        });
        return;
      }
      if (bookCb.type === 'book_opp') {
        await replyBookOpp(ctx, bookCb.oppId, { edit: true });
        return;
      }
      if (bookCb.type === 'book_draft_view') {
        await replyBookDraft(ctx, bookCb.draftId, { edit: true });
        return;
      }
      return;
    }

    const oppCb = parseOpportunityCallback(ctx.callbackQuery.data);
    if (oppCb) {
      if (oppCb.type === 'opp_scan') {
        await ctx.answerCallbackQuery({ text: 'اسکن فرصت…' });
        await doOpportunityScan(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_list' || oppCb.type === 'opp_hub') {
        await ctx.answerCallbackQuery();
        await replyOpportunitiesHub(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_rules') {
        await ctx.answerCallbackQuery();
        await replyOpportunityRules(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_profile') {
        await ctx.answerCallbackQuery();
        await replyScoringProfile(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_prof_edit' && wizard) {
        await ctx.answerCallbackQuery();
        const field = oppCb.field;
        if (field === 'skills') {
          wizard.set(ctx.from?.id, { kind: 'profile_skills' });
          await editOrReply(
            ctx,
            '🛠 مهارت‌های ترجیحی را با ویرگول بفرستید.\nمثال: وردپرس، react، seo\nلغو: /cancel',
            {},
            { edit: true }
          );
        } else if (field === 'budget') {
          wizard.set(ctx.from?.id, { kind: 'profile_budget' });
          await editOrReply(
            ctx,
            '💰 حداقل و حداکثر بودجه را بفرستید (تومان).\nمثال: 5000000 20000000\nلغو: /cancel',
            {},
            { edit: true }
          );
        } else if (field === 'cats') {
          wizard.set(ctx.from?.id, { kind: 'profile_cats' });
          await editOrReply(
            ctx,
            '📂 شناسه یا نام دسته‌ها را با ویرگول بفرستید.\nمثال: 6، 12\nلغو: /cancel',
            {},
            { edit: true }
          );
        }
        return;
      }
      if (oppCb.type === 'opp_rule_new' && wizard) {
        await ctx.answerCallbackQuery();
        wizard.set(ctx.from?.id, { kind: 'rule_create' });
        await editOrReply(ctx, formatRuleEditorHelp(), {}, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_rule_sample') {
        await ctx.answerCallbackQuery({ text: 'نمونه قانون' });
        if (db) {
          const store = createOpportunityStore(db);
          const existing = store.listRules();
          if (!existing.some((r) => r.name === 'نمونه-وردپرس')) {
            store.createRule({
              name: 'نمونه-وردپرس',
              action: 'CREATE_BID_DRAFT',
              priority: 50,
              conditions: [
                { field: 'skills', op: 'has_any', value: ['وردپرس', 'wordpress'] },
              ],
            });
          }
          const cur = store.getScoringProfile();
          if (!(cur.preferredSkills || []).length) {
            store.setScoringProfile({
              ...cur,
              preferredSkills: ['وردپرس', 'wordpress'],
              budgetMin: 1_000_000,
            });
          }
          getOppScanner()?.syncScoringAvailable?.();
        }
        await replyOpportunityRules(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_rule_view' && db) {
        await ctx.answerCallbackQuery();
        const store = createOpportunityStore(db);
        const rule = store.getRule(oppCb.ruleId);
        await editOrReply(
          ctx,
          formatOpportunityRule(rule),
          { reply_markup: opportunityRuleDetailKeyboard(oppCb.ruleId) },
          { edit: true }
        );
        return;
      }
      if (oppCb.type === 'opp_rule_toggle' && db) {
        await ctx.answerCallbackQuery({ text: 'قانون…' });
        const store = createOpportunityStore(db);
        const rule = store.getRule(oppCb.ruleId);
        if (rule) store.setRuleEnabled(oppCb.ruleId, !rule.enabled);
        await replyOpportunityRules(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_rule_edit' && db && wizard) {
        await ctx.answerCallbackQuery();
        wizard.set(ctx.from?.id, { kind: 'rule_edit', ruleId: oppCb.ruleId });
        await editOrReply(ctx, formatRuleEditorHelp(), {}, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_rule_delete' && db) {
        await ctx.answerCallbackQuery({ text: 'حذف شد' });
        createOpportunityStore(db).deleteRule(oppCb.ruleId);
        await replyOpportunityRules(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_view' && db) {
        await ctx.answerCallbackQuery();
        const store = createOpportunityStore(db);
        const row = store.get(oppCb.projectId);
        if (!row) {
          await editOrReply(ctx, 'فرصت پیدا نشد.', { reply_markup: opportunitiesListKeyboard([]) }, { edit: true });
          return;
        }
        const card = {
          opportunity: row.opportunity || row,
          score: row.score,
          reasons: row.scoreReasons || [],
          decision: row.decision,
        };
        await editOrReply(
          ctx,
          formatOpportunityDetails(card),
          { reply_markup: opportunityCardKeyboard(row.id) },
          { edit: true }
        );
        return;
      }
      if (oppCb.type === 'opp_ignore' && db) {
        await ctx.answerCallbackQuery({ text: 'نادیده گرفته شد' });
        const store = createOpportunityStore(db);
        const row = store.get(oppCb.projectId);
        store.setState(oppCb.projectId, 'IGNORED');
        try {
          store.recordAction({
            type: 'ignored',
            oppId: oppCb.projectId,
            note: 'رد / نادیده از تلگرام',
            preview: row?.title || null,
          });
          store.setDraftStatus(oppCb.projectId, 'rejected');
        } catch {
          /* ignore */
        }
        if (row) {
          const fb = createFeedbackStore(db);
          fb.record('ignore', row.opportunity || row);
          for (const r of row.matchedRules || []) {
            if (r.ruleId) fb.softPenaltyRule(r.ruleId, -1);
          }
        }
        await replyOpportunitiesHub(ctx, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_reject' && db) {
        await ctx.answerCallbackQuery({ text: 'رد با بازخورد' });
        const store = createOpportunityStore(db);
        const row = store.get(oppCb.projectId);
        store.setState(oppCb.projectId, 'IGNORED');
        try {
          store.recordAction({
            type: 'rejected',
            oppId: oppCb.projectId,
            note: 'رد با بازخورد',
            preview: row?.title || null,
          });
          store.setDraftStatus(oppCb.projectId, 'rejected');
        } catch {
          /* ignore */
        }
        if (row) {
          createFeedbackStore(db).record('reject', row.opportunity || row);
        }
        await replyOpportunitiesHub(ctx, { edit: true });
        return;
      }
      if ((oppCb.type === 'opp_draft' || oppCb.type === 'opp_smart') && db) {
        await ctx.answerCallbackQuery({ text: 'پیشنهاد هوشمند…' });
        await showSmartBid(ctx, oppCb.projectId, { edit: true });
        return;
      }
      if (oppCb.type === 'opp_bidreq' && db) {
        await ctx.answerCallbackQuery({ text: 'صف تأیید…' });
        await requestSmartBidApproval(ctx, oppCb.projectId);
        return;
      }
      if (oppCb.type === 'opp_bidedit' && db && wizard) {
        await ctx.answerCallbackQuery();
        const prev = wizard.get(ctx.from?.id) || {};
        wizard.set(ctx.from?.id, {
          kind: 'smart_bid_edit',
          projectId: oppCb.projectId,
          price: prev.price,
          days: prev.days,
        });
        await editOrReply(
          ctx,
          '✏️ متن پیشنهاد را بفرستید (فارسی انسانی).\nلغو: /cancel',
          {},
          { edit: true }
        );
        return;
      }
      if (oppCb.type === 'opp_prep_matched' && db) {
        await ctx.answerCallbackQuery({ text: 'آماده‌سازی…' });
        await prepMatchedOpportunities(ctx);
        return;
      }
    }

    if (parsed.type === 'nav_rules') {
      await ctx.answerCallbackQuery();
      await replyRules(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'nav_toggles') {
      await ctx.answerCallbackQuery();
      await replyToggles(ctx, { edit: true });
      return;
    }

    
    if (parsed.type === 'set_chat_ai_mode') {
      await ctx.answerCallbackQuery({ text: 'حالت AI گفتگو…' });
      if (!gate) {
        await ctx.reply('تنظیمات در دسترس نیست.', menuOpts());
        return;
      }
      try {
        gate.settings.setChatAiMode(parsed.mode);
      } catch (e) {
        await ctx.reply('حالت نامعتبر بود.', menuOpts());
        return;
      }
      await replyChatAiMode(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'nav_chatmode') {
      await ctx.answerCallbackQuery();
      await replyChatAiMode(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'goto_answered') {
      await ctx.answerCallbackQuery({ text: 'جواب‌داده‌شده‌ها…' });
      if (!roomFlows) {
        await ctx.reply('در دسترس نیست.', menuOpts());
        return;
      }
      await roomFlows.replyAnsweredList(ctx, { edit: true });
      return;
    }

if (parsed.type === 'set_mode') {
      await ctx.answerCallbackQuery({ text: 'حالت…' });
      await doSetMode(ctx, parsed.mode, { edit: true });
      return;
    }

    if (parsed.type === 'toggle') {
      await ctx.answerCallbackQuery({ text: 'سوئیچ…' });
      await doToggle(ctx, parsed.name, { edit: true });
      return;
    }

    if (parsed.type === 'toggle_confirm') {
      await ctx.answerCallbackQuery({ text: 'تأیید سوئیچ…' });
      await doToggleConfirm(ctx, parsed.name, {
        alsoModeAuto: Boolean(parsed.alsoModeAuto),
        edit: true,
      });
      return;
    }

    if (parsed.type === 'rule_view') {
      await ctx.answerCallbackQuery();
      await replyRules(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'rule_toggle') {
      await ctx.answerCallbackQuery({ text: 'قانون…' });
      await doRuleToggle(ctx, parsed.kind, { edit: true });
      return;
    }

    if (parsed.type === 'set_emergency') {
      await ctx.answerCallbackQuery({ text: 'توقف اضطراری' });
      await doEmergencyStop(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_emergency_clear') {
      await ctx.answerCallbackQuery({ text: 'رفع توقف' });
      await doEmergencyClear(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'edit_approval') {
      await ctx.answerCallbackQuery({ text: 'ویرایش' });
      const appr = queue?.getApproval?.(parsed.approvalId);
      if (!appr) {
        await ctx.reply('مورد تأیید پیدا نشد.', menuOpts());
        return;
      }
      let payload = {};
      try {
        payload = JSON.parse(appr.payload_json || '{}');
      } catch {
        payload = {};
      }
      const roomId = payload.roomId;
      if (roomId && roomFlows) {
        if (payload.text) {
          roomFlows.roomState.setDraft(roomId, { text: payload.text, source: 'approval_edit' });
        }
        await roomFlows.replyDraftScreen(ctx, roomId, { edit: true });
      } else {
        await ctx.reply(
          'ویرایش مستقیم برای این عملیات از پیش‌نویس گفتگو انجام می‌شود.\nگفتگو را باز کنید و پیش‌نویس را عوض کنید.',
          menuOpts()
        );
      }
      return;
    }

    if (parsed.type === 'nav_help') {
      await ctx.answerCallbackQuery();
      await replyHelp(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_pause') {
      await ctx.answerCallbackQuery({ text: 'مکث' });
      await doPause(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_resume') {
      await ctx.answerCallbackQuery({ text: 'ادامه' });
      await doResume(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_scan') {
      await ctx.answerCallbackQuery({ text: 'اسکن…' });
      await doScan(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_relogin') {
      await ctx.answerCallbackQuery({ text: 'تمدید نشست…' });
      await startReloginFlow(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_relogin_token') {
      await ctx.answerCallbackQuery({ text: 'توکن مرورگر…' });
      await startTokenPasteFlow(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_relogin_password') {
      await ctx.answerCallbackQuery({ text: 'ورود با رمز…' });
      await startPasswordFallbackFlow(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'set_relogin_cancel') {
      clearReloginState(ctx.chat?.id);
      await ctx.answerCallbackQuery({ text: 'لغو شد' });
      await ctx.reply(RELOGIN_MSG.CANCELLED, menuOpts());
      return;
    }

    if (parsed.type === 'nav_postwin') {
      await ctx.answerCallbackQuery();
      await replyPostWin(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'goto_approvals') {
      await ctx.answerCallbackQuery();
      await replyApprovals(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'goto_chats' || parsed.type === 'page_chats') {
      await ctx.answerCallbackQuery();
      if (!roomFlows) {
        await ctx.reply('گفتگوها در دسترس نیست.', menuOpts());
        return;
      }
      const page = parsed.type === 'page_chats' ? parsed.page : 1;
      await roomFlows.replyRoomsList(ctx, { unreadOnly: false, edit: true, page });
      return;
    }

    if (parsed.type === 'goto_unread' || parsed.type === 'page_unread') {
      await ctx.answerCallbackQuery();
      if (!roomFlows) {
        await ctx.reply('مهم‌ها در دسترس نیست.', menuOpts());
        return;
      }
      const page = parsed.type === 'page_unread' ? parsed.page : 1;
      await roomFlows.replyRoomsList(ctx, { unreadOnly: true, edit: true, page });
      return;
    }


    if (parsed.type === 'scan_priority') {
      await ctx.answerCallbackQuery({ text: 'اولویت‌ها…' });
      await renderScanView(ctx, 'priority', { edit: true, page: 1 });
      return;
    }
    if (parsed.type === 'scan_unread') {
      await ctx.answerCallbackQuery({ text: 'خوانده‌نشده…' });
      await renderScanView(ctx, 'unread', { edit: true });
      return;
    }
    if (parsed.type === 'scan_refresh') {
      await ctx.answerCallbackQuery({ text: 'اسکن…' });
      await doScan(ctx, { edit: true });
      return;
    }
    if (parsed.type === 'scan_prepare') {
      await ctx.answerCallbackQuery({ text: 'تحلیل…' });
      await doPrepareScan(ctx, { edit: true });
      return;
    }
    if (parsed.type === 'scan_chats') {
      await ctx.answerCallbackQuery();
      if (!roomFlows) {
        await ctx.reply('گفتگوها در دسترس نیست.', menuOpts());
        return;
      }
      await roomFlows.replyRoomsList(ctx, { unreadOnly: false, edit: true, page: 1 });
      return;
    }
    if (parsed.type === 'scan_details') {
      await ctx.answerCallbackQuery({ text: 'جزئیات…' });
      await renderScanView(ctx, 'details', { edit: true });
      return;
    }
    if (parsed.type === 'scan_back') {
      await ctx.answerCallbackQuery();
      await renderScanView(ctx, 'summary', { edit: true });
      return;
    }
    if (parsed.type === 'scan_page') {
      await ctx.answerCallbackQuery();
      // Prefer priority pagination when last summary has priority rooms; else re-scan page
      const summary = readLastScanSummary();
      if (summary?.priorityRooms?.length) {
        await renderScanView(ctx, 'priority', { edit: true, page: parsed.page || 1 });
      } else {
        await doScan(ctx, { edit: true, page: parsed.page || 1 });
      }
      return;
    }
    if (parsed.type === 'scan_room_details') {
      await ctx.answerCallbackQuery();
      await renderScanView(ctx, 'room_details', { edit: true, roomId: parsed.roomId });
      return;
    }
    
    if (parsed.type === 'room_pick') {
      await ctx.answerCallbackQuery({ text: 'انتخاب شد' });
      if (!roomFlows) return;
      await roomFlows.acceptPick(ctx, parsed.roomId);
      return;
    }
    if (parsed.type === 'room_skip') {
      await ctx.answerCallbackQuery({ text: 'رد شد' });
      if (!roomFlows) return;
      await roomFlows.skipPick(ctx, parsed.roomId);
      return;
    }
if (parsed.type === 'room_done') {
      await ctx.answerCallbackQuery({ text: 'بررسی شد' });
      if (roomFlows?.roomState?.setDecision) {
        roomFlows.roomState.setDecision(parsed.roomId, {
          status: 'reviewed',
          detail: 'local_reviewed',
        });
      }
      const summary = readLastScanSummary();
      const inScan = Boolean(
        summary?.priorityRooms?.some(
          (r) => String(r.roomId ?? r.id) === String(parsed.roomId)
        )
      );
      if (inScan) {
        await renderScanView(ctx, 'summary', { edit: true });
      } else if (roomFlows) {
        await roomFlows.replyRoomCard(ctx, parsed.roomId, { edit: true });
      } else {
        await renderScanView(ctx, 'summary', { edit: true });
      }
      return;
    }

    if (parsed.type?.startsWith('room_')) {
      if (!roomFlows) {
        await ctx.answerCallbackQuery({ text: 'db نیست', show_alert: true });
        return;
      }
      const rid = parsed.roomId;
      if (parsed.type === 'room_open') {
        await ctx.answerCallbackQuery({ text: 'باز کردن…' });
        await roomFlows.replyRoomCard(ctx, rid, { edit: true });
        return;
      }
      if (parsed.type === 'room_send') {
        await ctx.answerCallbackQuery({ text: 'پیش‌نمایش ارسال…' });
        await roomFlows.showSendConfirm(ctx, rid);
        return;
      }
      if (parsed.type === 'room_auto_rule') {
        await ctx.answerCallbackQuery({ text: 'قوانین…' });
        await roomFlows.showRoomAutoRule(ctx, rid);
        return;
      }
      if (parsed.type === 'room_approve') {
        // Confirmation step — do not send yet
        await ctx.answerCallbackQuery({ text: 'پیش‌نمایش…' });
        await roomFlows.showSendConfirm(ctx, rid);
        return;
      }
      if (parsed.type === 'room_confirm_send') {
        await ctx.answerCallbackQuery({ text: 'ثبت…' });
        await roomFlows.approveSend(ctx, rid);
        return;
      }
      if (parsed.type === 'room_cancel_confirm') {
        await ctx.answerCallbackQuery({ text: 'انصراف' });
        await roomFlows.replyRoomCard(ctx, rid, { edit: true });
        return;
      }
      if (parsed.type === 'room_reject') {
        await ctx.answerCallbackQuery({ text: 'رد شد' });
        await roomFlows.rejectRoom(ctx, rid);
        return;
      }
      if (parsed.type === 'room_note') {
        await ctx.answerCallbackQuery();
        await roomFlows.startNoteFlow(ctx, rid);
        return;
      }
      if (parsed.type === 'room_refresh') {
        await ctx.answerCallbackQuery({ text: 'تازه‌سازی…' });
        await roomFlows.replyRoomCard(ctx, rid, { edit: true });
        return;
      }
      if (parsed.type === 'room_ai') {
        await ctx.answerCallbackQuery({ text: 'تحلیل…' });
        await roomFlows.runAiAnalyze(ctx, rid);
        return;
      }
      if (parsed.type === 'room_messages') {
        await ctx.answerCallbackQuery({ text: 'پیام‌ها…' });
        await roomFlows.replyRoomMessages(ctx, rid, { edit: true });
        return;
      }
      if (parsed.type === 'room_draft') {
        await ctx.answerCallbackQuery({ text: 'پیش‌نویس…' });
        await roomFlows.replyDraftScreen(ctx, rid, { edit: true });
        return;
      }
      if (parsed.type === 'room_tech') {
        await ctx.answerCallbackQuery({ text: 'جزئیات فنی…' });
        await roomFlows.replyRoomTech(ctx, rid, { edit: true });
        return;
      }
      if (parsed.type === 'room_regen') {
        await ctx.answerCallbackQuery({ text: 'تولید دوباره…' });
        await roomFlows.replyDraftScreen(ctx, rid, { edit: true, regenerate: true });
        return;
      }
    }

    if (parsed.type === 'approve' || parsed.type === 'reject') {
      const approve = parsed.type === 'approve';
      const out = await decide(ctx, approve, parsed.approvalId);
      if (!out?.ok) {
        await ctx.answerCallbackQuery({ text: out?.text || 'پیدا نشد', show_alert: true });
        try {
          await ctx.editMessageText(out?.text || 'تأییدی پیدا نشد.');
        } catch {
          /* ignore */
        }
        return;
      }
      await ctx.answerCallbackQuery({ text: approve ? 'تأیید شد' : 'رد شد' });
      try {
        await ctx.editMessageText(out.text, {
          reply_markup: statusInlineKeyboard({ pendingCount: pendingCount() }),
        });
      } catch {
        await ctx.reply(out.text, menuOpts());
      }
    }
  });

  bot.catch((err) => {
    console.error('[telegram] bot error', err);
  });

  return {
    bot,
    runtime,
    gate,
    mutations,
    getPendingScanMessage: () => pendingScanMessage,
    clearPendingScanMessage: () => {
      pendingScanMessage = null;
      if (typeof hooks.onScanMessage === 'function') {
        try {
          hooks.onScanMessage(null);
        } catch {
          /* ignore */
        }
      }
    },
    async start() {
      console.log('[telegram] starting long polling…');
      try {
        await bot.api.setMyCommands(BOT_COMMANDS);
      } catch (e) {
        console.warn('[telegram] setMyCommands failed', e?.message || e);
      }
      await bot.start({
        onStart: (info) => {
          console.log(`[telegram] @${info.username} ready (id=${info.id})`);
        },
      });
    },
    async stop() {
      await bot.stop();
    },
  };
}

export default createBot;
