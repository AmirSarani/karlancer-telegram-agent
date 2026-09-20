import { Bot } from 'grammy';
import {
  BOT_COMMANDS,
  mainMenuKeyboard,
  statusInlineKeyboard,
  afterScanInlineKeyboard,
  approvalActionKeyboard,
  parseCallbackData,
  formatStatusCard,
  formatApprovalsList,
  formatWelcome,
  formatHelp,
  formatScanQueued,
  formatDecideResult,
  mapMenuText,
  formatAgeFa,
  approvalTarget,
} from './ui.js';
import { redactString } from '../security/redaction.js';

/**
 * Owner-only Telegram control plane with reply + inline keyboards.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {number|null} opts.ownerChatId
 * @param {{ queue?: object, onStatus?: Function }} [opts.hooks]
 */
export function createBot({ token, ownerChatId, hooks = {} }) {
  const bot = new Bot(token);
  const queue = hooks.queue || null;

  /** @type {{ state: 'running'|'paused', startedAt: string, lastCommandAt: string|null }} */
  const runtime = {
    state: 'running',
    startedAt: new Date().toISOString(),
    lastCommandAt: null,
  };

  function isOwner(ctx) {
    if (ownerChatId == null) return false;
    return ctx.chat?.id === ownerChatId || ctx.from?.id === ownerChatId;
  }

  async function denyIfNotOwner(ctx, { asCallback = false } = {}) {
    if (isOwner(ctx)) return false;
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    const msg =
      ownerChatId == null
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
        const failed = recent.find((j) => j.errorCode || j.status === 'failed' || j.status === 'dead_letter');
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
          // Keep only non-duplicated lines as extra footnotes
          const keep = raw
            .split('\n')
            .filter((l) => {
              const s = l.trim().toLowerCase();
              return s && !s.startsWith('db:') && !s.startsWith('worker:') && !s.startsWith('karlancer_auth:') && !s.startsWith('queue_depth:');
            })
            .join('\n');
          if (keep) card.extra = redactString(keep);
        }
      } catch {
        /* ignore */
      }
    }

    return card;
  }

  async function replyStatus(ctx, { edit = false } = {}) {
    const card = await collectStatus();
    const text = formatStatusCard(card);
    const reply_markup = statusInlineKeyboard({ pendingCount: card.pendingApprovals });
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { reply_markup });
        return;
      } catch {
        /* fall through to new message */
      }
    }
    await ctx.reply(text, { ...menuOpts(), reply_markup });
  }

  async function replyApprovals(ctx, { edit = false } = {}) {
    if (!queue) {
      const msg = 'صف job وصل نیست.';
      if (edit && ctx.callbackQuery) {
        try {
          await ctx.editMessageText(msg);
          return;
        } catch {
          /* fall through */
        }
      }
      await ctx.reply(msg, menuOpts());
      return;
    }
    const pending = queue.pendingApprovals();
    const { text, keyboards } = formatApprovalsList(pending);
    if (!pending.length) {
      if (edit && ctx.callbackQuery) {
        try {
          await ctx.editMessageText(text, {
            reply_markup: statusInlineKeyboard({ pendingCount: 0 }),
          });
          return;
        } catch {
          /* fall through */
        }
      }
      await ctx.reply(text, menuOpts());
      return;
    }
    // First approval: edit or send with its inline buttons; rest as follow-ups
    const firstKb = keyboards[0];
    if (edit && ctx.callbackQuery) {
      try {
        // When editing, show a summary + first item actions only in one message
        const a = pending[0];
        const { action, target } = approvalTarget(a);
        const summary = [
          `📋 تأییدهای در انتظار (${pending.length})`,
          '',
          `🧾 مورد اول`,
          `• عمل: ${action}`,
          `• هدف: ${target}`,
          `• سن: ${formatAgeFa(a.created_at)}`,
          `• شناسه: ${String(a.approval_id).slice(0, 8)}…`,
          pending.length > 1 ? `\nبقیه موارد در پیام‌های بعدی.` : '',
        ]
          .filter(Boolean)
          .join('\n');
        await ctx.editMessageText(summary, { reply_markup: firstKb });
      } catch {
        await ctx.reply(
          [
            `📋 تأییدهای در انتظار (${pending.length})`,
            '',
            (() => {
              const { action, target } = approvalTarget(pending[0]);
              return [
                `🧾 مورد ۱`,
                `• عمل: ${action}`,
                `• هدف: ${target}`,
                `• سن: ${formatAgeFa(pending[0].created_at)}`,
              ].join('\n');
            })(),
          ].join('\n'),
          { ...menuOpts(), reply_markup: firstKb }
        );
      }
    } else {
      await ctx.reply(
        [
          `📋 تأییدهای در انتظار (${pending.length})`,
          '',
          (() => {
            const { action, target } = approvalTarget(pending[0]);
            return [
              `🧾 مورد ۱`,
              `• عمل: ${action}`,
              `• هدف: ${target}`,
              `• سن: ${formatAgeFa(pending[0].created_at)}`,
              `• شناسه: ${String(pending[0].approval_id).slice(0, 8)}…`,
            ].join('\n');
          })(),
        ].join('\n'),
        { ...menuOpts(), reply_markup: firstKb }
      );
    }
    for (let i = 1; i < Math.min(pending.length, 8); i++) {
      const a = pending[i];
      const { action, target } = approvalTarget(a);
      await ctx.reply(
        [
          `🧾 مورد ${i + 1}`,
          `• عمل: ${action}`,
          `• هدف: ${target}`,
          `• سن: ${formatAgeFa(a.created_at)}`,
          `• شناسه: ${String(a.approval_id).slice(0, 8)}…`,
        ].join('\n'),
        { reply_markup: approvalActionKeyboard(a.approval_id) }
      );
    }
  }

  async function doPause(ctx) {
    runtime.state = 'paused';
    await ctx.reply('⏸ ایجنت روی مکث است. برای ادامه «ادامه» را بزنید.', menuOpts());
  }

  async function doResume(ctx) {
    runtime.state = 'running';
    await ctx.reply('▶️ ایجنت دوباره در حال اجراست.', menuOpts());
  }

  async function doScan(ctx) {
    if (!queue) {
      await ctx.reply('صف job وصل نیست.', menuOpts());
      return;
    }
    if (runtime.state === 'paused') {
      await ctx.reply('ایجنت روی مکث است — اول «ادامه» را بزنید.', menuOpts());
      return;
    }
    const job = queue.create({
      goal: 'rooms.scan',
      requestedBy: `telegram:${ctx.from?.id}`,
      payload: { page: 1 },
    });
    await ctx.reply(formatScanQueued(job.jobId), {
      ...menuOpts(),
      reply_markup: afterScanInlineKeyboard(),
    });
  }

  async function decide(ctx, approve, approvalIdHint) {
    if (!queue) {
      await ctx.reply('صف job وصل نیست.', menuOpts());
      return null;
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
    await ctx.reply(formatWelcome(), menuOpts());
  });

  bot.command('help', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await ctx.reply(formatHelp(), menuOpts());
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

  // —— Reply keyboard text map ——
  bot.on('message:text', async (ctx, next) => {
    const action = mapMenuText(ctx.message.text);
    if (!action) return next();
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (action === 'status') return replyStatus(ctx);
    if (action === 'approvals') return replyApprovals(ctx);
    if (action === 'scan') return doScan(ctx);
    if (action === 'pause') return doPause(ctx);
    if (action === 'resume') return doResume(ctx);
    if (action === 'help') return ctx.reply(formatHelp(), menuOpts());
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

    if (parsed.type === 'refresh_status') {
      await ctx.answerCallbackQuery({ text: 'به‌روزرسانی…' });
      await replyStatus(ctx, { edit: true });
      return;
    }

    if (parsed.type === 'goto_approvals') {
      await ctx.answerCallbackQuery();
      await replyApprovals(ctx, { edit: true });
      return;
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
