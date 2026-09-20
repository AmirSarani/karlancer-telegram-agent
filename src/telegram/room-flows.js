/**
 * Per-chat Telegram control flows (list / open / approve / reject / note / AI).
 * Sending is API-driven via VerifiedMutationContract — never LLM.
 */
import crypto from 'node:crypto';
import { createRoomState } from '../agent/room-state.js';
import { adaptDraftWithNote, analyzeRoomWithLlm } from '../agent/analyze-llm.js';
import { getVerifiedMutation } from '../api/contracts/verified-mutation.js';
import {
  formatRoomCard,
  formatRoomsList,
  roomCardKeyboard,
} from './room-card.js';
import { redactString } from '../security/redaction.js';

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<import('../worker/queue.js').createJobQueue>|null} deps.queue
 * @param {ReturnType<import('../api/adapters/index.js').createKarlancerApi>|null} deps.api
 * @param {object|null} deps.llm
 * @param {Function} deps.menuOpts
 */
export function createRoomFlows(deps) {
  const { db, queue, api, llm, menuOpts } = deps;
  const roomState = createRoomState(db);

  function sendApiLive() {
    return Boolean(getVerifiedMutation('messages.send'));
  }

  async function listRoomsFromApi({ unreadOnly = false } = {}) {
    if (!api?.client?.hasAuth) {
      return { ok: false, error: 'کارلنسر احراز هویت نشده.' };
    }
    const { rooms } = await api.rooms.list({ page: 1 });
    let list = (rooms || []).map((r) => ({
      id: r.id,
      roomId: r.id,
      guestName: r.guestName || r.title,
      unread: Number(r.unread) || 0,
      lastMessage: r.lastMessage,
      updatedAt: r.updatedAt,
    }));
    if (unreadOnly) list = list.filter((r) => r.unread > 0);
    // Also include pending decision rooms from kv
    if (!unreadOnly) {
      for (const id of roomState.listPendingRoomIds()) {
        if (!list.some((r) => String(r.id) === String(id))) {
          const card = roomState.getCard(id);
          if (card) {
            list.unshift({
              id,
              roomId: id,
              guestName: card.guestName,
              unread: card.unread || 0,
              lastMessage: card.messages?.slice(-1)?.[0]?.text || '',
              updatedAt: card.updatedAt,
            });
          }
        }
      }
    }
    return { ok: true, rooms: list };
  }

  async function buildFreshCard(roomId) {
    if (!api?.client?.hasAuth) {
      const cached = roomState.getCard(roomId);
      if (cached) return { ...cached, sendApiLive: sendApiLive() };
      return null;
    }
    // Reuse poll for one room
    const { runMessagesPoll } = await import('../agent/messages-poll.js');
    const out = await runMessagesPoll({ api, db, roomState }, { roomId, page: 1 });
    if (out.ok && out.result?.cards?.length) {
      return out.result.cards[0];
    }
    return roomState.getCard(roomId);
  }

  async function replyRoomsList(ctx, { unreadOnly = false, edit = false } = {}) {
    const title = unreadOnly ? '🔴 خوانده‌نشده' : '💬 چت‌ها';
    const res = await listRoomsFromApi({ unreadOnly });
    if (!res.ok) {
      await ctx.reply(res.error, menuOpts());
      return;
    }
    const { text, items } = formatRoomsList(res.rooms, { title, max: 10 });
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text);
      } catch {
        await ctx.reply(text, menuOpts());
      }
    } else {
      await ctx.reply(text, menuOpts());
    }
    for (const item of items.slice(0, 10)) {
      await ctx.reply(`اتاق #${item.roomId}`, { reply_markup: item.keyboard });
    }
  }

  async function replyRoomCard(ctx, roomId, { edit = false } = {}) {
    let card = await buildFreshCard(roomId);
    if (!card) {
      card = roomState.getCard(roomId);
    }
    if (!card) {
      const msg = `کارت اتاق #${roomId} پیدا نشد. اول «خوانده‌نشده» یا poll را بزنید.`;
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
    card.sendApiLive = sendApiLive();
    card.decisionStatus = roomState.getDecision(roomId)?.status || card.decisionStatus;
    card.draftText = roomState.getDraft(roomId)?.text || card.draftText;
    card.ownerNote = roomState.getNote(roomId)?.text || card.ownerNote;
    const text = formatRoomCard(card);
    const kb = roomCardKeyboard(roomId);
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { reply_markup: kb });
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(text, { ...menuOpts(), reply_markup: kb });
  }

  async function approveSend(ctx, roomId) {
    const draft = roomState.getDraft(roomId);
    const text = draft?.text || roomState.getCard(roomId)?.draftText || '';
    if (!text.trim()) {
      await ctx.reply('پیش‌نویسی برای ارسال نیست. اول تازه‌سازی یا نوت بزنید.', menuOpts());
      return;
    }

    if (!queue) {
      await ctx.reply('صف job وصل نیست.', menuOpts());
      return;
    }

    const live = sendApiLive();
    // Create messages.send with requiresApproval, then immediately approve (owner already clicked)
    const job = queue.create({
      goal: 'messages.send',
      requiresApproval: true,
      payload: { roomId: String(roomId), text },
      requestedBy: `telegram:${ctx.from?.id}`,
      targetRef: String(roomId),
      operationId: crypto.randomUUID(),
      idempotencyKey: `msg-send:${roomId}:${crypto
        .createHash('sha256')
        .update(text)
        .digest('hex')
        .slice(0, 16)}`,
    });

    const approval = queue.getApprovalForJob(job.jobId);
    if (!approval) {
      await ctx.reply('ثبت تأیید ناموفق بود.', menuOpts());
      return;
    }
    const decided = queue.decideApproval(approval.approval_id, {
      approve: true,
      decidedBy: `telegram:${ctx.from?.id}`,
    });

    if (decided?.tampered) {
      await ctx.reply('⚠️ payload مشکوک — ارسال انجام نشد.', menuOpts());
      return;
    }

    roomState.setDecision(roomId, { status: live ? 'approved' : 'blocked', detail: live ? null : 'blocked_by_missing_api' });

    if (!live) {
      // Worker will also mark needs_reconciliation; be honest in Telegram now
      await ctx.reply(
        [
          `✅ تأیید ثبت شد برای اتاق #${roomId}`,
          '⛔ ارسال واقعی: blocked_by_missing_api',
          'Job در وضعیت needs_reconciliation صف می‌شود تا قرارداد VerifiedMutation ثبت شود.',
          'پیش‌نویس محفوظ است — بعد از ثبت API دوباره تأیید کنید.',
        ].join('\n'),
        menuOpts()
      );
      return;
    }

    await ctx.reply(
      [
        `✅ تأیید شد — ارسال در صف worker`,
        `اتاق: #${roomId}`,
        `job: ${String(job.jobId).slice(0, 8)}…`,
        decided?.job?.status ? `وضعیت: ${decided.job.status}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      menuOpts()
    );
  }

  async function rejectRoom(ctx, roomId) {
    roomState.setDecision(roomId, { status: 'rejected' });
    // Cancel any pending messages.send for this room
    if (queue) {
      const pending = queue.pendingApprovals();
      for (const a of pending) {
        if (a.action !== 'messages.send') continue;
        let payload = {};
        try {
          payload = JSON.parse(a.payload_json || '{}');
        } catch {
          payload = {};
        }
        if (String(payload.roomId) === String(roomId)) {
          queue.decideApproval(a.approval_id, {
            approve: false,
            decidedBy: `telegram:${ctx.from?.id}`,
          });
        }
      }
    }
    await ctx.reply(`❌ اتاق #${roomId} رد شد. پیش‌نویس ارسال نمی‌شود.`, menuOpts());
  }

  async function startNoteFlow(ctx, roomId) {
    roomState.setAwaitingNote(ctx.from?.id, roomId);
    await ctx.reply(
      `📝 نوت برای اتاق #${roomId}\nمتن راهنما را در پیام بعدی بفرستید (فقط همین چت).\nبرای لغو: /cancel`,
      menuOpts()
    );
  }

  async function handleNoteText(ctx, roomId, noteText) {
    roomState.clearAwaitingNote(ctx.from?.id);
    roomState.setNote(roomId, noteText);
    const card = roomState.getCard(roomId) || { roomId };
    const current = roomState.getDraft(roomId)?.text || card.draftText || '';

    await ctx.reply('در حال اعمال نوت (تحلیل AI در صورت فعال بودن)…', menuOpts());

    const adapted = await adaptDraftWithNote({
      roomContext: {
        roomId,
        guestName: card.guestName,
        project: card.project,
        messages: card.messages,
        projectTitle: card.project?.title,
      },
      currentDraft: current,
      ownerNote: noteText,
      llm,
      mode: 'note',
    });

    roomState.setDraft(roomId, {
      text: adapted.text,
      source: adapted.source,
      meta: { llmUsed: adapted.llmUsed },
    });
    roomState.setDecision(roomId, { status: 'pending' });
    roomState.setCard(roomId, {
      ...card,
      draftText: adapted.text,
      ownerNote: noteText,
      decisionStatus: 'pending',
      sendApiLive: sendApiLive(),
    });

    await ctx.reply(
      [
        `نوت اعمال شد (منبع: ${adapted.source}${adapted.llmUsed ? ' · AI' : ' · بدون AI'})`,
        '',
        'کارت به‌روز:',
      ].join('\n'),
      menuOpts()
    );
    await replyRoomCard(ctx, roomId);
  }

  async function runAiAnalyze(ctx, roomId) {
    const card = roomState.getCard(roomId) || (await buildFreshCard(roomId)) || { roomId };
    await ctx.reply('🤖 در حال تحلیل AI…', menuOpts());
    const analysis = await analyzeRoomWithLlm({
      roomContext: { project: card.project, guestName: card.guestName },
      llm,
    });
    // Also polish draft if we have messages
    const adapted = await adaptDraftWithNote({
      roomContext: {
        roomId,
        guestName: card.guestName,
        project: card.project,
        messages: card.messages,
      },
      currentDraft: roomState.getDraft(roomId)?.text || card.draftText || '',
      ownerNote: roomState.getNote(roomId)?.text || 'لطفاً پیش‌نویس را حرفه‌ای و کوتاه‌تر کن.',
      llm,
      mode: 'analyze',
    });
    if (adapted.text) {
      roomState.setDraft(roomId, { text: adapted.text, source: adapted.source });
      roomState.setDecision(roomId, { status: 'pending' });
    }
    await ctx.reply(
      [
        analysis.ok ? `📊 خلاصه تحلیل:\n${redactString(analysis.summary).slice(0, 1200)}` : `📊 ${analysis.summary}`,
        '',
        adapted.llmUsed ? 'پیش‌نویس با AI به‌روز شد.' : 'پیش‌نویس با قالب/نوت به‌روز شد (AI در دسترس نبود).',
      ].join('\n'),
      menuOpts()
    );
    await replyRoomCard(ctx, roomId);
  }

  return {
    roomState,
    replyRoomsList,
    replyRoomCard,
    approveSend,
    rejectRoom,
    startNoteFlow,
    handleNoteText,
    runAiAnalyze,
    sendApiLive,
    /**
     * Handle free-text if awaiting note; returns true if consumed.
     */
    async maybeHandleAwaitingNote(ctx) {
      const roomId = roomState.getAwaitingNote(ctx.from?.id);
      if (!roomId) return false;
      const text = ctx.message?.text || '';
      if (text.trim() === '/cancel') {
        roomState.clearAwaitingNote(ctx.from?.id);
        await ctx.reply('نوت لغو شد.', menuOpts());
        return true;
      }
      await handleNoteText(ctx, roomId, text);
      return true;
    },
  };
}

export default createRoomFlows;
