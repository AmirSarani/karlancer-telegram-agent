/**
 * Per-chat Telegram control flows (list / open / confirm-send / reject / note / AI).
 * Sending is API-driven via VerifiedMutationContract — never LLM.
 */
import crypto from 'node:crypto';
import {
  extractPriceFeatures,
  getRoomPriceAnswer,
  getRoomPriceAsk,
  parseTomanAmount,
  recordPriceSample,
  setRoomPriceAnswer,
} from '../agent/price-memory.js';
import { splitTelegramText } from './split-text.js';
import { createRoomState } from '../agent/room-state.js';
import { adaptDraftWithNote, analyzeRoomWithLlm } from '../agent/analyze-llm.js';
import { getVerifiedMutation } from '../api/contracts/verified-mutation.js';
import {
  formatRoomCard,
  formatRoomsList,
  formatSendConfirmPreview,
  formatAiAnalysisCard,
  formatRoomTechDetails,
  formatRoomMessagesView,
  formatDraftScreen,
  roomCardKeyboard,
  roomPickKeyboard,
  roomAnsweredOpenKeyboard,
  roomConfirmKeyboard,
  roomDraftKeyboard,
  roomMessagesKeyboard,
  roomTechKeyboard,
} from './room-card.js';
import { buildDraftReply } from '../agent/draft-api.js';
import { cleanHumanReply } from '../agent/reply-clean.js';
import {
  formatLoading,
  formatComplete,
  formatFriendlyError,
  friendlyErrorText,
  formatRulesCard,
  rulesInlineKeyboard,
} from './ui.js';
import { createPermissionGate } from './permission-gate.js';
import { createMutationRequester } from './mutation-request.js';

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
  const gate = deps.gate || (db ? createPermissionGate(db) : null);
  const mutations =
    deps.mutations ||
    (queue && gate ? createMutationRequester({ queue, gate }) : null);

  function sendApiLive() {
    return Boolean(getVerifiedMutation('messages.send'));
  }

  async function editOrReply(ctx, text, extra = {}, { edit = false } = {}) {
    const parts = splitTelegramText(String(text ?? ''));
    if (parts.length > 1) {
      const { reply_markup, ...rest } = extra || {};
      let edited = false;
      if (edit && ctx.callbackQuery) {
        try {
          await ctx.editMessageText(parts[0], rest);
          edited = true;
        } catch {
          edited = false;
        }
      }
      if (!edited) await ctx.reply(parts[0], { ...menuOpts(), ...rest });
      for (let i = 1; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        await ctx.reply(parts[i], { ...rest, ...(isLast && reply_markup ? { reply_markup } : {}) });
      }
      return edited ? 'edited' : 'replied';
    }
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
    const requestedBy = `telegram:${ctx.from?.id}`;
    const opId = crypto.randomUUID();
    const idempotencyKey = `msg-send:${roomId}:${crypto
      .createHash('sha256')
      .update(text)
      .digest('hex')
      .slice(0, 16)}`;

    let decided = null;
    let job = null;

    if (mutations) {
      const out = mutations.request({
        action: 'messages.send',
        payload: {
          roomId: String(roomId),
          text,
          risk: 'high',
          aiReason: 'تأیید دستی مالک پس از پیش‌نمایش',
        },
        gateCtx: {
          source: 'owner_confirm',
          roomId: String(roomId),
          text,
          riskHint: 'high',
        },
        requestedBy,
        targetRef: String(roomId),
        operationId: opId,
        idempotencyKey,
      });
      if (out.denied) {
        await ctx.reply(
          `⛔ ارسال مجاز نیست.\n${out.verdict?.reasonFa || out.verdict?.reason || ''}`,
          menuOpts()
        );
        return;
      }
      if (out.error) {
        await ctx.reply('ثبت تأیید ناموفق بود.', menuOpts());
        return;
      }
      decided = out.decided;
      job = out.job;
      if (decided?.tampered) {
        await ctx.reply('⚠️ payload مشکوک — ارسال انجام نشد.', menuOpts());
        return;
      }
    } else {
      // Fallback without gate (should be rare)
      job = queue.create({
        goal: 'messages.send',
        requiresApproval: true,
        payload: { roomId: String(roomId), text },
        requestedBy,
        targetRef: String(roomId),
        operationId: opId,
        idempotencyKey,
      });
      const approval = queue.getApprovalForJob(job.jobId);
      if (!approval) {
        await ctx.reply('ثبت تأیید ناموفق بود.', menuOpts());
        return;
      }
      decided = queue.decideApproval(approval.approval_id, {
        approve: true,
        decidedBy: requestedBy,
      });
      if (decided?.tampered) {
        await ctx.reply('⚠️ payload مشکوک — ارسال انجام نشد.', menuOpts());
        return;
      }
    }

    // «جواب داده شد» only after the worker confirms the send (message.sent event).
    roomState.setDecision(roomId, {
      status: live ? 'sending' : 'blocked',
      detail: live ? (decided?.job || job)?.jobId || null : 'blocked_by_missing_api',
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
      (decided?.job || job)?.status ? `وضعیت: ${(decided?.job || job).status}` : null,
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

  /** Link from conversation card → automation rules. */
  async function showRoomAutoRule(ctx, roomId) {
    const s = gate ? gate.settings.get() : {};
    const text = [
      formatRulesCard(s),
      '',
      `گفتگوی فعلی: ${roomId}`,
      'از اینجا قوانین سراسری را ببینید یا روشن/خاموش کنید.',
    ].join('\n');
    await editOrReply(
      ctx,
      text,
      { reply_markup: rulesInlineKeyboard() },
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
      text: cleanHumanReply(adapted.text),
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
        roomContext: { project: card.project, guestName: card.guestName, messages: card.messages },
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
      roomState.setDraft(roomId, { text: cleanHumanReply(adapted.text), source: adapted.source });
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


  function enrichCard(roomId, card = {}) {
    return {
      ...card,
      roomId: card.roomId ?? roomId,
      sendApiLive: sendApiLive(),
      decisionStatus: roomState.getDecision(roomId)?.status || card.decisionStatus,
      draftText: roomState.getDraft(roomId)?.text || card.draftText,
      ownerNote: roomState.getNote(roomId)?.text || card.ownerNote,
    };
  }

  async function replyRoomMessages(ctx, roomId, { edit = false } = {}) {
    let card = await buildFreshCard(roomId);
    if (!card) card = roomState.getCard(roomId);
    if (!card) {
      await replyRoomCard(ctx, roomId, { edit });
      return;
    }
    card = enrichCard(roomId, card);
    await editOrReply(
      ctx,
      formatRoomMessagesView(card),
      { reply_markup: roomMessagesKeyboard(roomId) },
      { edit }
    );
  }

  async function replyRoomTech(ctx, roomId, { edit = false } = {}) {
    let card = await buildFreshCard(roomId);
    if (!card) card = roomState.getCard(roomId);
    if (!card) {
      await replyRoomCard(ctx, roomId, { edit });
      return;
    }
    card = enrichCard(roomId, card);
    await editOrReply(
      ctx,
      formatRoomTechDetails(card),
      { reply_markup: roomTechKeyboard(roomId) },
      { edit }
    );
  }

  async function replyDraftScreen(ctx, roomId, { edit = false, regenerate = false } = {}) {
    let card = (await buildFreshCard(roomId)) || roomState.getCard(roomId) || { roomId };
    card = enrichCard(roomId, card);

    let draftText = roomState.getDraft(roomId)?.text || card.draftText || '';
    if (regenerate || !String(draftText).trim()) {
      if (ctx.callbackQuery) {
        try {
          await ctx.editMessageText(formatLoading('ai'), {
            reply_markup: roomDraftKeyboard(roomId),
          });
        } catch {
          await ctx.reply(formatLoading('ai'), menuOpts());
        }
      }
      const built = buildDraftReply({
        roomId,
        guestName: card.guestName,
        project: card.project,
        messages: card.messages,
        ownerNote: roomState.getNote(roomId)?.text || '',
      });
      // Optional LLM polish when available
      const adapted = await adaptDraftWithNote({
        roomContext: {
          roomId,
          guestName: card.guestName,
          project: card.project,
          messages: card.messages,
        },
        currentDraft: built.text,
        ownerNote:
          roomState.getNote(roomId)?.text ||
          'پیش‌نویس را طبیعی، کوتاه و حرفه‌ای بنویس؛ مثل فریلنسر واقعی.',
        llm,
        mode: regenerate ? 'analyze' : 'note',
      });
      draftText = cleanHumanReply(adapted.text || built.text);
      roomState.setDraft(roomId, {
        text: draftText,
        source: adapted.source || built.source,
      });
      roomState.setDecision(roomId, { status: 'pending' });
      card.draftText = draftText;
    } else {
      draftText = cleanHumanReply(draftText);
      card.draftText = draftText;
    }

    await editOrReply(
      ctx,
      formatDraftScreen(card),
      { reply_markup: roomDraftKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) || edit }
    );
  }


  async function replyAnsweredList(ctx, { edit = false, page = 1 } = {}) {
    const title = '✅ جواب‌داده‌شده‌ها';
    const ids = roomState.listAnsweredRoomIds();
    const rooms = [];
    for (const id of ids) {
      const card = roomState.getCard(id);
      const thread = roomState.getThread(id);
      rooms.push({
        id,
        roomId: id,
        guestName: card?.guestName || card?.guest_name || `گفتگو ${id}`,
        unread: 0,
        lastMessage: thread?.lastSentText || card?.draftText || '',
        updatedAt: thread?.lastSentAt || card?.updatedAt || null,
        threadPhase: 'answered',
      });
    }
    // newest first
    rooms.sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0));
    const formatted = formatRoomsList(rooms, { title, page, unreadOnly: false });
    await editOrReply(ctx, formatted.text || (title + '\n————————\nهنوز موردی نیست.'), {
      reply_markup: formatted.keyboard,
    }, { edit });
  }

  async function markRoomAnsweredManual(ctx, roomId) {
    const draft = roomState.getDraft(roomId);
    roomState.markAnswered(roomId, {
      lastSentText: draft?.text || roomState.getCard(roomId)?.draftText || null,
    });
    await editOrReply(
      ctx,
      ['✅ به جواب‌داده‌شده‌ها منتقل شد.', `گفتگو: ${roomId}`].join('\n'),
      { reply_markup: roomCardKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) }
    );
  }

  // —— Phase C: «چه قیمتی بدهم؟» ——

  function formatTomanFa(n) {
    return `${Number(n).toLocaleString('fa-IR')} تومان`;
  }

  async function applyOwnerPrice(ctx, roomId, amount, source) {
    const ask = getRoomPriceAsk(db, roomId);
    const card = roomState.getCard(roomId) || {};
    setRoomPriceAnswer(db, roomId, { amount, source });
    try {
      recordPriceSample(db, {
        amount,
        source,
        roomId,
        projectId: card.project?.id ?? null,
        features: ask?.features || extractPriceFeatures({ project: card.project || null, messages: card.messages || [] }),
      });
    } catch {
      /* learning is best effort */
    }
    roomState.setThread(roomId, { suggestedPrice: amount });
    let queued = false;
    if (queue) {
      queue.create({
        goal: 'chat.resume_price',
        requestedBy: `telegram:${ctx.from?.id}`,
        payload: { roomId: String(roomId) },
      });
      queued = true;
    }
    await editOrReply(
      ctx,
      [
        `✅ قیمت ${formatTomanFa(amount)} ثبت شد.`,
        queued
          ? 'پاسخ با همین قیمت آماده می‌شود؛ اگر قوانین خودکار اجازه بدهد ارسال می‌شود، وگرنه برای تأیید شما می‌آید.'
          : 'از «📝 پیش‌نویس» پاسخ را با همین قیمت آماده کنید.',
        'این قیمت برای قیمت‌گذاری کارهای مشابه بعدی هم یاد گرفته شد.',
      ].join('\n'),
      { reply_markup: roomCardKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) }
    );
  }

  async function acceptSuggestedPrice(ctx, roomId) {
    const ask = getRoomPriceAsk(db, roomId);
    if (!ask?.suggested) {
      const done = getRoomPriceAnswer(db, roomId);
      await editOrReply(
        ctx,
        done
          ? `قیمت این گفتگو قبلاً ثبت شده: ${formatTomanFa(done.amount)}`
          : 'پیشنهادی برای این گفتگو ثبت نشده؛ «✏️ مبلغ دیگر» را بزنید.',
        { reply_markup: roomCardKeyboard(roomId) },
        { edit: false }
      );
      return;
    }
    await applyOwnerPrice(ctx, roomId, Number(ask.suggested), 'owner_approved');
  }

  async function startPriceEntry(ctx, roomId) {
    roomState.setAwaitingPrice(ctx.from?.id, roomId);
    await ctx.reply(
      'مبلغ را به تومان بفرستید؛ مثلاً «۲۵ میلیون» یا «۲۵۰۰۰۰۰۰».\nلغو: /cancel',
      menuOpts()
    );
  }

  /** Owner picked «جواب بدم» → open draft / confirm path */
  async function acceptPick(ctx, roomId) {
    roomState.setDecision(roomId, { status: 'pending', detail: 'picked_to_answer' });
    await replyDraftScreen(ctx, roomId, { edit: Boolean(ctx.callbackQuery) });
  }

  async function skipPick(ctx, roomId) {
    roomState.setDecision(roomId, { status: 'rejected', detail: 'pick_skipped' });
    await editOrReply(
      ctx,
      '⏭ فعلاً رد شد. هر وقت خواستید از گفتگوها باز کنید.',
      { reply_markup: roomCardKeyboard(roomId) },
      { edit: Boolean(ctx.callbackQuery) }
    );
  }

  return {
    roomState,
    gate,
    mutations,
    replyRoomsList,
    replyAnsweredList,
    markRoomAnsweredManual,
    acceptPick,
    skipPick,
    replyRoomCard,
    replyRoomMessages,
    replyRoomTech,
    replyDraftScreen,
    showSendConfirm,
    approveSend,
    showRoomAutoRule,
    rejectRoom,
    startNoteFlow,
    handleNoteText,
    runAiAnalyze,
    sendApiLive,
    acceptSuggestedPrice,
    startPriceEntry,
    applyOwnerPrice,
    /**
     * Handle free-text amount if awaiting a price answer; returns true if consumed.
     */
    async maybeHandleAwaitingPrice(ctx) {
      const roomId = roomState.getAwaitingPrice(ctx.from?.id);
      if (!roomId) return false;
      const text = (ctx.message?.text || '').trim();
      if (text === '/cancel') {
        roomState.clearAwaitingPrice(ctx.from?.id);
        await ctx.reply('لغو شد.', menuOpts());
        return true;
      }
      const amount = parseTomanAmount(text);
      if (!amount) {
        await ctx.reply('مبلغ را متوجه نشدم. به تومان بفرستید؛ مثلاً «۲۵ میلیون». لغو: /cancel', menuOpts());
        return true;
      }
      roomState.clearAwaitingPrice(ctx.from?.id);
      await applyOwnerPrice(ctx, roomId, amount, 'owner_answer');
      return true;
    },
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
