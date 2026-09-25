/**
 * messages.poll — list rooms, fetch new messages, draft + card payloads.
 * Pure orchestration helpers used by worker handler (API injected).
 */
import {
  dedupeMessages,
  roomNeedsFetch,
  extractProjectSlug,
} from './message-normalize.js';
import { buildDraftReply } from './draft-api.js';
import { extractProposalHints } from '../telegram/room-card.js';
import { getVerifiedMutation } from '../api/contracts/verified-mutation.js';
import { logger } from '../observability/logger.js';
import { createChatContinuum } from './chat-continuum.js';
import { markOwnMessages, sortChronological } from './conversation.js';
import { getOwnUserId } from './own-identity.js';

/**
 * @param {object} ctx
 * @param {object} ctx.api
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {ReturnType<import('./room-state.js').createRoomState>} ctx.roomState
 * @param {object|null} [ctx.llm]
 * @param {object|null} [ctx.gate]
 * @param {object|null} [ctx.mutations]
 * @param {() => boolean} [ctx.getAllowLiveAutoSend]
 * @param {object} [payload]
 */
export async function runMessagesPoll(ctx, payload = {}) {
  const { api, roomState, db, llm = null, gate = null, mutations = null } = ctx;
  const getAllowLiveAutoSend =
    typeof ctx.getAllowLiveAutoSend === 'function'
      ? ctx.getAllowLiveAutoSend
      : () => false;
  const page = payload.page || 1;
  const maxRooms = Math.min(20, Number(payload.maxRooms) || 10);
  const forceRoomId = payload.roomId != null ? String(payload.roomId) : null;

  if (!api.client.hasAuth) {
    roomState.setPollHealth({ ok: false, error: 'missing_auth' });
    return { ok: false, errorCode: 'missing_auth', detail: 'KARLANCER_ACCESS_TOKEN required' };
  }

  const sendApiLive = Boolean(getVerifiedMutation('messages.send'));
  const ownUserId = await getOwnUserId({ api, db }).catch(() => null);
  const { rooms, pagination } = await api.rooms.list({ page });
  const list = (rooms || []).filter(Boolean);

  /** Prefer unread, then recently updated */
  const sorted = [...list].sort((a, b) => {
    const au = Number(a.unread) > 0 ? 1 : 0;
    const bu = Number(b.unread) > 0 ? 1 : 0;
    if (bu !== au) return bu - au;
    const at = Date.parse(a.updatedAt || '') || 0;
    const bt = Date.parse(b.updatedAt || '') || 0;
    return bt - at;
  });

  const candidates = forceRoomId
    ? sorted.filter((r) => String(r.id) === forceRoomId).length
      ? sorted.filter((r) => String(r.id) === forceRoomId)
      : [{ id: forceRoomId, unread: 1, updatedAt: null, guestName: null, lastMessage: '' }]
    : sorted.filter((r) => roomNeedsFetch(r, roomState.getCursor(r.id))).slice(0, maxRooms);

  const newInboundCards = [];
  let roomsFetched = 0;
  let messagesSeen = 0;
  let freshCount = 0;

  for (const room of candidates) {
    try {
      roomsFetched += 1;
      const data = await api.messages.list(room.id, { page: 1 });
      const messages = markOwnMessages(data.messages || [], ownUserId);
      messagesSeen += messages.length;

      const seen = roomState.getSeenIds(room.id);
      const { fresh, seen: newSeen } = dedupeMessages(messages, seen);
      // Persist all observed ids (not only inbound) to avoid re-notify
      roomState.addSeenIds(room.id, [...newSeen]);

      const freshInbound = fresh.filter((m) => m.isOwn !== true);
      freshCount += freshInbound.length;

      // Resolve project if slug/id available
      let project = null;
      let projectSlug =
        messages.map((m) => m.projectSlug).find(Boolean) ||
        extractProjectSlug(room.lastMessage || '') ||
        null;
      const projectId = messages.map((m) => m.projectId).find(Boolean) || null;
      if (projectSlug || projectId) {
        try {
          if (projectSlug) {
            const got = await api.projects.getBySlug(projectSlug);
            project = got.project;
          } else if (projectId) {
            const got = await api.projects.get(projectId);
            project = got.project;
            projectSlug = got.slug || projectSlug;
          }
        } catch (e) {
          logger.warn('messages_poll_project_failed', {
            roomId: room.id,
            err: e.message,
            code: e.code,
          });
        }
      }

      const guestName =
        data.roomMeta?.guestName || room.guestName || room.title || null;
      const unread = data.roomUnread ?? room.unread ?? null;

      // Attachments across recent messages
      const attachments = [];
      for (const m of messages) {
        for (const a of m.attachments || []) attachments.push(a);
      }

      // Proposal hints from own or any message mentioning هزینه
      let proposalPrice = null;
      let proposalDays = null;
      for (const m of messages) {
        const hints = extractProposalHints(m.text || '');
        if (hints.price != null) proposalPrice = hints.price;
        if (hints.days != null) proposalDays = hints.days;
      }

      const existingNote = roomState.getNote(room.id)?.text || '';
      const draft = buildDraftReply({
        roomId: room.id,
        guestName,
        project,
        messages,
        ownerNote: existingNote,
        proposal: { price: proposalPrice, days: proposalDays },
      });
      roomState.setDraft(room.id, draft);

      const decision = roomState.getDecision(room.id);
      // Reset to pending when brand-new inbound arrives (unless already rejected this wave — keep rejected)
      if (freshInbound.length && decision?.status !== 'rejected') {
        roomState.setDecision(room.id, { status: 'pending' });
      } else if (!decision) {
        roomState.setDecision(room.id, { status: 'pending' });
      }

      const card = {
        roomId: String(room.id),
        guestName,
        unread,
        updatedAt: room.updatedAt || data.roomMeta?.updatedAt || null,
        project: project
          ? {
              id: project.id,
              title: project.title,
              minBudget: project.minBudget,
              maxBudget: project.maxBudget,
              jobDuration: project.jobDuration,
              hireDeadline: project.hireDeadline,
              isFulltime: project.isFulltime ?? data.isRequiredFulltime,
              isUrgent: project.isUrgent,
              description: project.description
                ? String(project.description).slice(0, 20000)
                : null,
              skills: Array.isArray(project.skills) ? project.skills.slice(0, 15) : [],
              category: project.category || null,
            }
          : null,
        projectSlug,
        messages: sortChronological(messages).slice(-12).map((m) => ({
          id: m.id,
          text: m.text,
          isOwn: m.isOwn,
          senderId: m.senderId ?? null,
          createdAt: m.createdAt,
        })),
        clientUserId:
          sortChronological(messages)
            .reverse()
            .find((m) => m.isOwn === false && (m.senderId || m.userId))?.senderId ||
          data.roomMeta?.userId ||
          null,
        attachments,
        attachmentsNote: attachments.length
          ? null
          : 'API لینک فایلی در این صفحه برنگرداند',
        proposalPrice,
        proposalDays,
        draftText: draft.text,
        ownerNote: existingNote || null,
        decisionStatus: roomState.getDecision(room.id)?.status || 'pending',
        sendApiLive,
        hasReply: data.hasReply,
        isRequiredFulltime: data.isRequiredFulltime,
        freshInboundCount: freshInbound.length,
        freshInboundIds: freshInbound.map((m) => m.id).filter(Boolean),
      };

      roomState.setCard(room.id, card);
      // Owner replied directly on the Karlancer website → register as answered so the 24h follow-up applies.
      try {
        registerWebsiteReply(roomState, room.id, messages);
      } catch {
        /* best effort */
      }
      roomState.setCursor(room.id, {
        lastUpdatedAt: room.updatedAt || new Date().toISOString(),
        lastMessageId: messages[0]?.id || messages[messages.length - 1]?.id || null,
      });

      // Notify on new inbound OR forced room refresh for unread
      if (freshInbound.length > 0 || (forceRoomId && Number(unread) > 0) || (Number(unread) > 0 && !decision)) {
        newInboundCards.push(card);
      } else if (freshInbound.length === 0 && Number(room.unread) > 0 && !roomState.getCard(room.id)) {
        newInboundCards.push(card);
      }
    } catch (e) {
      logger.warn('messages_poll_room_failed', { roomId: room?.id, err: e.message, code: e.code });
    }
  }

  // Also surface unread rooms from list that we didn't fetch (list-only cards)
  const unreadListed = sorted.filter((r) => Number(r.unread) > 0).slice(0, 5);

  const polledAt = new Date().toISOString();
  const summary = {
    page,
    total: pagination?.total ?? list.length,
    lastPage: pagination?.lastPage ?? null,
    roomsOnPage: list.length,
    roomsFetched,
    messagesSeen,
    freshCount,
    newCards: newInboundCards.length,
    unreadOnPage: unreadListed.length,
    pendingDecisions: roomState.pendingCount(),
    sendApiLive,
    polledAt,
    priorityUnread: unreadListed.map((r) => ({
      roomId: r.id,
      guestName: r.guestName || r.title,
      unread: Number(r.unread) || 0,
      lastMessage: String(r.lastMessage || '').slice(0, 120),
    })),
  };

  roomState.setPollHealth({
    ok: true,
    ...summary,
  });

  // Mode-aware continuum: LLM / pick / auto (never unlimited)
  let cards = newInboundCards;
  if (cards.length && db) {
    try {
      const continuum = createChatContinuum({
        db,
        roomState,
        llm,
        gate,
        mutations,
        getAllowLiveAutoSend,
        budget: ctx.budget || null,
      });
      cards = await continuum.processPollCards(cards);
      summary.newCards = cards.length;
      summary.chatAiMode = continuum.getMode();
      summary.continuumActions = cards.map((c) => ({
        roomId: c.roomId,
        action: c.continuumAction,
        pick: Boolean(c.pickPrompt),
      }));
    } catch (e) {
      logger.warn('messages_poll_continuum_failed', { err: e.message });
    }
  }

  return {
    ok: true,
    result: {
      ...summary,
      cards,
    },
  };
}

export default runMessagesPoll;

/**
 * If the newest message in the room is ours (sender_id == own user id) and it is not the text the
 * bot itself sent, the owner answered on the website: mark the room answered with that message time.
 * @returns {boolean} true when the thread was updated
 */
export function registerWebsiteReply(roomState, roomId, messages = [], { now = Date.now() } = {}) {
  const chrono = sortChronological(messages || []);
  const last = chrono[chrono.length - 1];
  if (!last || last.isOwn !== true) return false;
  const thread = roomState.getThread(roomId) || {};
  const lastId = last.id != null ? String(last.id) : null;
  if (lastId && thread.lastOwnMsgId === lastId) return false;
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const sentByBot = thread.lastSentText && norm(thread.lastSentText) === norm(last.text);
  const parsed = Date.parse(last.createdAt || '');
  const at = Number.isFinite(parsed) && parsed <= now + 60_000 ? new Date(parsed).toISOString() : new Date(now).toISOString();
  if (sentByBot) {
    roomState.setThread(roomId, { lastOwnMsgId: lastId });
    return false;
  }
  const prevSent = Date.parse(thread.lastSentAt || '');
  if (Number.isFinite(prevSent) && Date.parse(at) <= prevSent) {
    roomState.setThread(roomId, { lastOwnMsgId: lastId });
    return false;
  }
  roomState.setThread(roomId, {
    phase: 'answered',
    lastSentAt: at,
    lastSentText: String(last.text || '').slice(0, 4000),
    lastOwnMsgId: lastId,
    answeredVia: 'website',
  });
  const d = roomState.getDecision(roomId);
  if (!d || d.status === 'pending') roomState.setDecision(roomId, { status: 'answered', detail: 'website_reply' });
  return true;
}
