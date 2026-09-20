import { Bot } from 'grammy';

/**
 * Owner-only Telegram control plane integrated with durable jobs / approvals.
 */

/**
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

  function pendingCount() {
    return queue ? queue.pendingApprovals().length : 0;
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
        'کارلنسر Agent (API-first) آماده است.',
        '',
        'دستورات:',
        '/help — راهنما',
        '/status — وضعیت + صف',
        '/pause — توقف موقت worker claim',
        '/resume — ادامه',
        '/approvals — لیست تأییدهای در انتظار',
        '/approve — تأیید اولین/شناسه',
        '/reject — رد',
        '/scan — صف اسکن دعوت‌ها',
      ].join('\n')
    );
  });

  bot.command('help', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    await ctx.reply(
      [
        'راهنمای کنترل Agent کارلنسر (بدون Playwright)',
        '',
        '/status — running/paused + jobs',
        '/pause|/resume — کنترل runtime',
        '/approvals — pending HITL',
        '/approve [approval_id] — تأیید',
        '/reject [approval_id] — رد',
        '/scan — enqueue rooms.scan',
        '',
        'Mutationها فقط بعد از approval اجرا می‌شوند.',
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
      `pendingApprovals: ${pendingCount()}`,
      `ownerChatId: ${ownerChatId}`,
    ];
    if (queue) {
      const queued = queue.list({ status: 'queued', limit: 20 }).length;
      const running = queue.list({ status: 'running', limit: 20 }).length;
      const waiting = queue.list({ status: 'waiting_for_approval', limit: 20 }).length;
      lines.push(`jobs queued=${queued} running=${running} waiting_approval=${waiting}`);
    }
    if (typeof hooks.onStatus === 'function') {
      try {
        const extra = await hooks.onStatus(runtime);
        if (extra) lines.push(String(extra));
      } catch {
        /* ignore */
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

  bot.command('approvals', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (!queue) {
      await ctx.reply('صف job وصل نیست.');
      return;
    }
    const pending = queue.pendingApprovals();
    if (!pending.length) {
      await ctx.reply('تأییدی در انتظار نیست.');
      return;
    }
    const lines = pending.slice(0, 10).map((a) => {
      let payload = {};
      try {
        payload = JSON.parse(a.payload_json || '{}');
      } catch {
        /* ignore */
      }
      return `• ${a.approval_id.slice(0, 8)}… job=${a.job_id.slice(0, 8)}… action=${a.action} project=${payload.projectId || '—'}`;
    });
    await ctx.reply(['Pending approvals:', ...lines, '', 'Use /approve <id> or /reject <id>'].join('\n'));
  });

  async function decide(ctx, approve) {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (!queue) {
      await ctx.reply('صف job وصل نیست.');
      return;
    }
    const arg = ctx.match?.trim?.() || (ctx.message?.text || '').split(/\s+/).slice(1).join(' ').trim();
    let approval = null;
    const pending = queue.pendingApprovals();
    if (arg) {
      approval = pending.find((a) => a.approval_id === arg || a.approval_id.startsWith(arg));
    } else {
      approval = pending[0];
    }
    if (!approval) {
      await ctx.reply('approval پیدا نشد. /approvals را ببینید.');
      return;
    }
    const result = queue.decideApproval(approval.approval_id, {
      approve,
      decidedBy: `telegram:${ctx.from?.id}`,
    });
    await ctx.reply(
      `${approve ? 'approved' : 'rejected'}: ${approval.approval_id}\njob status → ${result?.job?.status}`
    );
  }

  bot.command('approve', (ctx) => decide(ctx, true));
  bot.command('reject', (ctx) => decide(ctx, false));

  bot.command('scan', async (ctx) => {
    if (await denyIfNotOwner(ctx)) return;
    touch();
    if (!queue) {
      await ctx.reply('صف job وصل نیست.');
      return;
    }
    if (runtime.state === 'paused') {
      await ctx.reply('Agent pause است — اول /resume');
      return;
    }
    const job = queue.create({
      goal: 'rooms.scan',
      requestedBy: `telegram:${ctx.from?.id}`,
      payload: { page: 1 },
    });
    await ctx.reply(`اسکن صف شد.\njob_id: ${job.jobId}`);
  });

  bot.catch((err) => {
    console.error('[telegram] bot error', err);
  });

  return {
    bot,
    runtime,
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
