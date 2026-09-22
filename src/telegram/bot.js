import { Bot } from 'grammy';
import {
  BOT_COMMANDS,
  mainMenuKeyboard,
  statusInlineKeyboard,
  afterScanInlineKeyboard,
  settingsInlineKeyboard,
  homeInlineKeyboard,
  approvalActionKeyboard,
  parseCallbackData,
  formatStatusCard,
  formatApprovalsList,
  formatWelcome,
  formatHelp,
  formatSettingsCard,
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
import { redactString } from '../security/redaction.js';
import { createRoomFlows } from './room-flows.js';
import {
  beginRelogin,
  clearReloginState,
  getReloginState,
  handleReloginText,
  MSG as RELOGIN_MSG,
  reloginCancelKeyboard,
} from './relogin-flow.js';

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

  const roomFlows =
    db != null
      ? createRoomFlows({ db, queue, api, llm, menuOpts })
      : null;

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
    const text = formatSettingsCard({
      state: runtime.state,
      karlancerAuth: api?.client ? Boolean(api.client.hasAuth) : null,
    });
    const reply_markup = settingsInlineKeyboard(runtime.state);
    await editOrReply(ctx, text, { reply_markup }, { edit });
  }

  async function startReloginFlow(ctx, { edit = false } = {}) {
    beginRelogin(ctx.chat.id);
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
    const { action, target, preview } = approvalTarget(a);
    const summary = [
      `✅ تأییدهای در انتظار (${toFaNum(pending.length)})`,
      '————————',
      '',
      '🧾 مورد اول',
      `• عملیات: ${actionLabelFa(action)}`,
      `• مقصد: ${target}`,
      preview ? `• متن: «${truncatePreview(preview, 100)}»` : null,
      `• زمان: ${formatAgeFa(a.created_at)}`,
      `• شناسه: ${String(a.approval_id).slice(0, 8)}…`,
      pending.length > 1 ? '\nبقیه موارد در پیام‌های بعدی.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    await editOrReply(ctx, summary, { reply_markup: firstKb }, { edit });
    for (let i = 1; i < Math.min(pending.length, 8); i++) {
      const item = pending[i];
      const t = approvalTarget(item);
      await ctx.reply(
        [
          `🧾 مورد ${toFaNum(i + 1)}`,
          `• عملیات: ${actionLabelFa(t.action)}`,
          `• مقصد: ${t.target}`,
          t.preview ? `• متن: «${truncatePreview(t.preview, 100)}»` : null,
          `• زمان: ${formatAgeFa(item.created_at)}`,
          `• شناسه: ${String(item.approval_id).slice(0, 8)}…`,
        ]
          .filter(Boolean)
          .join('\n'),
        { reply_markup: approvalActionKeyboard(item.approval_id) }
      );
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
      payload: { page },
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
    if (getReloginState(ctx.chat?.id)) {
      clearReloginState(ctx.chat.id);
      await ctx.reply(RELOGIN_MSG.CANCELLED, menuOpts());
      return;
    }
    await ctx.reply('لغو شد.', menuOpts());
  });

  // —— Reply keyboard text map ——
  bot.on('message:text', async (ctx, next) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (roomFlows && (await roomFlows.maybeHandleAwaitingNote(ctx))) return;

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
    if (action === 'chats') {
      if (!roomFlows) return ctx.reply('گفتگوها در دسترس نیست.', menuOpts());
      return roomFlows.replyRoomsList(ctx, { unreadOnly: false });
    }
    if (action === 'alerts' || action === 'unread') {
      if (!roomFlows) return ctx.reply('مهم‌ها در دسترس نیست.', menuOpts());
      return roomFlows.replyRoomsList(ctx, { unreadOnly: true });
    }
    if (action === 'settings') return replySettings(ctx);
    if (action === 'scan') return doScan(ctx);
    if (action === 'pause') return doPause(ctx);
    if (action === 'resume') return doResume(ctx);
    if (action === 'help') return replyHelp(ctx);
  });

  // —— Inline callbacks ——
  bot.on('callback_query:data', async (ctx) => {
    if (await denyIfNotOwner(ctx, { asCallback: true })) return;
    touch();
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

    if (parsed.type === 'set_relogin_cancel') {
      clearReloginState(ctx.chat?.id);
      await ctx.answerCallbackQuery({ text: 'لغو شد' });
      await ctx.reply(RELOGIN_MSG.CANCELLED, menuOpts());
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
