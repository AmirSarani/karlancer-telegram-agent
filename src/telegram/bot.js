import { Bot } from 'grammy';

/**
 * Owner-only Telegram control plane (long polling via grammY).
 * Commands are stubs for MVP; wiring to agent/browser comes later.
 */

/** @typedef {'running'|'paused'} AgentRuntimeState */

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {number|null} opts.ownerChatId
 * @param {{ onStatus?: Function }} [opts.hooks]
 */
export function createBot({ token, ownerChatId, hooks = {} }) {
  const bot = new Bot(token);

  /** @type {{ state: AgentRuntimeState, startedAt: string, lastCommandAt: string|null, pendingApprovals: number }} */
  const runtime = {
    state: 'running',
    startedAt: new Date().toISOString(),
    lastCommandAt: null,
    pendingApprovals: 0,
  };

  function isOwner(ctx) {
    if (ownerChatId == null) return false;
    return ctx.chat?.id === ownerChatId || ctx.from?.id === ownerChatId;
  }

  async function denyIfNotOwner(ctx) {
    if (isOwner(ctx)) return false;
    const chatId = ctx.chat?.id;
    await ctx.reply(
      ownerChatId == null
        ? `این بات هنوز به owner قفل نشده.\nchat id شما: \`${chatId}\`\nآن را در TELEGRAM_OWNER_CHAT_ID بگذارید و بات را ری‌استارت کنید.`
        : 'دسترسی فقط برای owner است.'
    );
    return true;
  }

  function touch() {
    runtime.lastCommandAt = new Date().toISOString();
  }

  bot.command('start', async (ctx) => {
    touch();
    const chatId = ctx.chat?.id;
    if (!isOwner(ctx)) {
      await ctx.reply(
        `سلام 👋\nchat id شما: \`${chatId}\`\n\nاگر owner هستید این مقدار را در TELEGRAM_OWNER_CHAT_ID تنظیم کنید، سپس npm start.`
      );
      return;
    }
    await ctx.reply(
      [
        'کارلنسر Agent آماده است.',
        '',
        'دستورات:',
        '/help — راهنما',
        '/status — وضعیت',
        '/pause — توقف موقت',
        '/resume — ادامه',
        '/approve — تأیید اقدام در انتظار',
        '/reject — رد اقدام در انتظار',
      ].join('\n')
    );
  });

  bot.command('help', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await ctx.reply(
      [
        'راهنمای کنترل Agent کارلنسر',
        '',
        '/status — حالت فعلی (running/paused) و آمار ساده',
        '/pause — Agent را pause می‌کند (اسکن/پاسخ خودکار متوقف)',
        '/resume — از حالت pause خارج می‌شود',
        '/approve — stub: تأیید draft/اقدام HITL',
        '/reject — stub: رد draft/اقدام HITL',
        '',
        'مرورگر Playwright و اتصال به karlancer.com در مراحل بعدی وصل می‌شود.',
      ].join('\n')
    );
  });

  bot.command('status', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    const lines = [
      `state: ${runtime.state}`,
      `startedAt: ${runtime.startedAt}`,
      `lastCommandAt: ${runtime.lastCommandAt || '—'}`,
      `pendingApprovals: ${runtime.pendingApprovals}`,
      `ownerChatId: ${ownerChatId}`,
    ];
    if (typeof hooks.onStatus === 'function') {
      try {
        const extra = await hooks.onStatus(runtime);
        if (extra) lines.push(String(extra));
      } catch {
        /* ignore hook errors in MVP */
      }
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('pause', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    runtime.state = 'paused';
    await ctx.reply('Agent روی pause است. /resume برای ادامه.');
  });

  bot.command('resume', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    runtime.state = 'running';
    await ctx.reply('Agent دوباره running است.');
  });

  bot.command('approve', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    // Stub: later bind to pending HITL draft queue
    if (runtime.pendingApprovals > 0) runtime.pendingApprovals -= 1;
    await ctx.reply('approve دریافت شد (stub). صف HITL هنوز به Playwright وصل نیست.');
  });

  bot.command('reject', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (runtime.pendingApprovals > 0) runtime.pendingApprovals -= 1;
    await ctx.reply('reject دریافت شد (stub). صف HITL هنوز به Playwright وصل نیست.');
  });

  bot.catch((err) => {
    console.error('[telegram] bot error', err);
  });

  return {
    bot,
    runtime,
    /**
     * Start long polling. Resolves when polling starts (grammY start is blocking).
     */
    async start() {
      console.log('[telegram] starting long polling…');
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
