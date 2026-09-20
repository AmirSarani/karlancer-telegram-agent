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

/**
 * @param {object} ctx
 * @param {object} ctx.api
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {ReturnType<import('./room-state.js').createRoomState>} ctx.roomState
 * @param {object} [payload]
 */
export async function runMessagesPoll(ctx, payload = {}) {
  const { api, roomState } = ctx;
  const page = payload.page || 1;
  const maxRooms = Math.min(20, Number(payload.maxRooms) || 10);
  const forceRoomId = payload.roomId != null ? String(payload.roomId) : null;

  if (!api.client.hasAuth) {
    roomState.setPollHealth({ ok: false, error: 'missing_auth' });
    return { ok: false, errorCode: 'missing_auth', detail: 'KARLANCER_ACCESS_TOKEN required' };
  }

  const sendApiLive = Boolean(getVerifiedMutation('messages.send'));
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
      const messages = data.messages || [];
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
                ? String(project.description).slice(0, 500)
                : null,
            }
          : null,
        projectSlug,
        messages: messages.slice(-8).map((m) => ({
          id: m.id,
          text: m.text,
          isOwn: m.isOwn,
          createdAt: m.createdAt,
        })),
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

  return {
    ok: true,
    result: {
      ...summary,
      cards: newInboundCards,
    },
  };
}

export default runMessagesPoll;
