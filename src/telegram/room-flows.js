/**
 * Per-chat Telegram control flows (list / open / confirm-send / reject / note / AI).
 * Sending is API-driven via VerifiedMutationContract — never LLM.
 */
import crypto from 'node:crypto';
import { createRoomState } from '../agent/room-state.js';
import { adaptDraftWithNote, analyzeRoomWithLlm } from '../agent/analyze-llm.js';
import { getVerifiedMutation } from '../api/contracts/verified-mutation.js';
import {
  formatRoomCard,
  formatRoomsList,
  formatSendConfirmPreview,
  formatAiAnalysisCard,
  roomCardKeyboard,
  roomConfirmKeyboard,
} from './room-card.js';
import {
  formatLoading,
  formatComplete,
  formatFriendlyError,
  friendlyErrorText,
} from './ui.js';

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

  async function editOrReply(ctx, text, extra = {}, { edit = false } = {}) {
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, extra);
        return 'edited';
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(text, { ...menuOpts(), ...extra });
    return 'replied';
  }

  async function listRoomsFromApi({ unreadOnly = false } = {}) {
    if (!api?.client?.hasAuth) {
      return { ok: false, error: 'نشست کارلنسر فعال نیست. توکن سرور را بررسی کنید.' };
    }
    try {
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
    } catch (e) {
      return { ok: false, error: friendlyErrorText(e) };
    }
  }

  async function buildFreshCard(roomId) {
    if (!api?.client?.hasAuth) {
      const cached = roomState.getCard(roomId);
      if (cached) return { ...cached, sendApiLive: sendApiLive() };
      return null;
    }
    try {
      const { runMessagesPoll } = await import('../agent/messages-poll.js');
      const out = await runMessagesPoll({ api, db, roomState }, { roomId, page: 1 });
      if (out.ok && out.result?.cards?.length) {
        return out.result.cards[0];
      }
      return roomState.getCard(roomId);
    } catch {
      return roomState.getCard(roomId);
    }
  }

  async function replyRoomsList(ctx, { unreadOnly = false, edit = false, page = 1 } = {}) {
    const title = unreadOnly ? '🔥 مهم‌ها' : '💬 گفتگوها';
    const res = await listRoomsFromApi({ unreadOnly });
    if (!res.ok) {
      const { text, keyboard } = formatFriendlyError(res.error, {
        title: '⚠️ دریافت گفتگوها',
        retryCallback: unreadOnly ? 'goto:unread' : 'goto:chats',
      });
      await editOrReply(ctx, text, { reply_markup: keyboard }, { edit });
      return;
    }
    const formatted = formatRoomsList(res.rooms, {
      title,
      page,
      unreadOnly,
    });
    await editOrReply(
      ctx,
      formatted.text,
      { reply_markup: formatted.keyboard },
      { edit }
    );
  }

  async function replyRoomCard(ctx, roomId, { edit = false } = {}) {
    let card = await buildFreshCard(roomId);
    if (!card) {
      card = roomState.getCard(roomId);
    }
    if (!card) {
      const { text, keyboard } = formatFriendlyError(
        `این گفتگو پیدا نشد. اول مهم‌ها یا اسکن را بزنید.`,
        { title: '⚠️ گفتگو', retryCallback: 'goto:chats' }
      );
      await editOrReply(ctx, text, { reply_markup: keyboard }, { edit });
      return;
    }
    card.sendApiLive = sendApiLive();
    card.decisionStatus = roomState.getDecision(roomId)?.status || card.decisionStatus;
    card.draftText = roomState.getDraft(roomId)?.text || card.draftText;
    card.ownerNote = roomState.getNote(roomId)?.text || card.ownerNote;
    const text = formatRoomCard(card);
    const kb = roomCardKeyboard(roomId);
    await editOrReply(ctx, text, { reply_markup: kb }, { edit });
  }

  /**
   * Step 1 of send: show confirmation preview (does not queue job yet).
   */
  async function showSendConfirm(ctx, roomId) {
    const draft = roomState.getDraft(roomId);
    const cached = roomState.getCard(roomId) || {};
    const text = draft?.text || cached.draftText || '';
    if (!text.trim()) {
      await editOrReply(
        ctx,
        [
          '📝 پیش‌نویس خالی است',
          '————————',
          '',
          'اول نوت یا خلاصه AI بزنید، بعد تأیید ارسال.',
        ].join('\n'),
        { reply_markup: roomCardKeyboard(roomId) },
        { edit: true }
      );
      return;
    }
    const preview = formatSendConfirmPreview({
      roomId,
      guestName: cached.guestName,
      draftText: text,
      sendApiLive: sendApiLive(),
    });
    await editOrReply(
      ctx,
      preview,
      { reply_markup: roomConfirmKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) }
    );
  }

  /**
   * Step 2 of send: after Confirm — create job (honest about blocked_by_missing_api).
   */
  async function approveSend(ctx, roomId) {
    const draft = roomState.getDraft(roomId);
    const text = draft?.text || roomState.getCard(roomId)?.draftText || '';
    if (!text.trim()) {
      await ctx.reply('پیش‌نویسی برای ارسال نیست. اول تازه‌سازی یا نوت بزنید.', menuOpts());
      return;
    }

    if (!queue) {
      const { text: errText, keyboard } = formatFriendlyError('صف عملیات وصل نیست.', {
        retryCallback: `room:cfm:${roomId}`,
      });
      await ctx.reply(errText, { ...menuOpts(), reply_markup: keyboard });
      return;
    }

    const live = sendApiLive();
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

    roomState.setDecision(roomId, {
      status: live ? 'approved' : 'blocked',
      detail: live ? null : 'blocked_by_missing_api',
    });

    if (!live) {
      const msg = [
        formatComplete('send'),
        '————————',
        '⛔ ارسال واقعی فعلاً فعال نیست (blocked_by_missing_api).',
        'تأیید ثبت شد؛ ارسال پس از آماده‌شدن مسیر انجام می‌شود.',
        'پیش‌نویس محفوظ است.',
      ].join('\n');
      await editOrReply(
        ctx,
        msg,
        { reply_markup: roomCardKeyboard(roomId) },
        { edit: Boolean(ctx.callbackQuery) }
      );
      return;
    }

    const msg = [
      formatComplete('send', 'ارسال در صف قرار گرفت.'),
      `گفتگو ثبت شد.`,
      decided?.job?.status ? `وضعیت: ${decided.job.status}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    await editOrReply(
      ctx,
      msg,
      { reply_markup: roomCardKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) }
    );
  }

  async function rejectRoom(ctx, roomId) {
    roomState.setDecision(roomId, { status: 'rejected' });
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
    await editOrReply(
      ctx,
      [
        formatComplete('reject'),
        'این گفتگو رد شد.',
        'پیش‌نویس ارسال نمی‌شود.',
      ].join('\n'),
      { reply_markup: roomCardKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) }
    );
  }

  async function startNoteFlow(ctx, roomId) {
    roomState.setAwaitingNote(ctx.from?.id, roomId);
    await ctx.reply(
      [
        '📝 نوت برای این گفتگو',
        '————————',
        '',
        'متن راهنما را در پیام بعدی بفرستید.',
        'برای لغو: /cancel',
      ].join('\n'),
      menuOpts()
    );
  }

  async function handleNoteText(ctx, roomId, noteText) {
    roomState.clearAwaitingNote(ctx.from?.id);
    roomState.setNote(roomId, noteText);
    const card = roomState.getCard(roomId) || { roomId };
    const current = roomState.getDraft(roomId)?.text || card.draftText || '';

    await ctx.reply(formatLoading('note'), menuOpts());

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
      formatComplete(
        'note',
        `منبع: ${adapted.source}${adapted.llmUsed ? ' · AI' : ' · بدون AI'}`
      ),
      menuOpts()
    );
    await replyRoomCard(ctx, roomId);
  }

  async function runAiAnalyze(ctx, roomId) {
    const card = roomState.getCard(roomId) || (await buildFreshCard(roomId)) || { roomId };
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(formatLoading('ai'), {
          reply_markup: roomCardKeyboard(roomId),
        });
      } catch {
        await ctx.reply(formatLoading('ai'), menuOpts());
      }
    } else {
      await ctx.reply(formatLoading('ai'), menuOpts());
    }

    let analysis;
    try {
      analysis = await analyzeRoomWithLlm({
        roomContext: { project: card.project, guestName: card.guestName },
        llm,
      });
    } catch (e) {
      const { text, keyboard } = formatFriendlyError(e, {
        title: '⚠️ تحلیل AI',
        retryCallback: `room:ai:${roomId}`,
      });
      await editOrReply(ctx, text, { reply_markup: keyboard }, { edit: true });
      return;
    }

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
    let draftUpdated = false;
    if (adapted.text) {
      roomState.setDraft(roomId, { text: adapted.text, source: adapted.source });
      roomState.setDecision(roomId, { status: 'pending' });
      draftUpdated = true;
    }

    const cardText = formatAiAnalysisCard(analysis, { roomId, draftUpdated });
    await editOrReply(
      ctx,
      cardText,
      { reply_markup: roomCardKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) }
    );
  }

  return {
    roomState,
    replyRoomsList,
    replyRoomCard,
    showSendConfirm,
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
