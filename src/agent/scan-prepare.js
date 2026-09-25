/**
 * After rooms.scan finds priority / invite hits: run the same Brain pipeline as
 * chat continuum (analyze + humanized draft) and enqueue HITL approvals.
 *
 * Default: prepare + forceRequireApproval only — never live send/bid from scan
 * unless caller explicitly opts into continuum full_auto (still gated).
 * Reuses analyzeRoomWithLlm / adaptDraftWithNote / cleanHumanReply / PermissionGate /
 * VerifiedMutationContract — does not fork a second brain.
 */
import crypto from 'node:crypto';
import { analyzeRoomWithLlm, adaptDraftWithNote } from './analyze-llm.js';
import { cleanHumanReply } from './reply-clean.js';
import { buildDraftReply } from './draft-api.js';
import { suggestChatPrice } from './chat-price.js';
import { extractProjectSlug } from './message-normalize.js';
import { markOwnMessages, sortChronological } from './conversation.js';
import { getOwnUserId } from './own-identity.js';
import { createRoomState } from './room-state.js';
import { createAgentSettingsStore } from '../telegram/agent-settings.js';
import { buildSmartBid } from '../opportunity/smart-bid.js';
import { createOpportunityStore } from '../opportunity/store.js';
import { logger } from '../observability/logger.js';
import { memoryAppend } from '../memory/store.js';

export const SCAN_PREPARE_DEFAULT_MAX = 5;
export const SCAN_PREPARE_HARD_MAX = 10;

/**
 * Scan default = prepare drafts + HITL (never live send from this path).
 * Skip only on emergency stop. Assisted/Auto and chat AI modes still govern
 * live auto-send elsewhere; scan always forceRequireApproval.
 * full_manual users still get drafts into تأییدها — they only confirm.
 * @param {object} [settings]
 */
export function shouldAutoPrepareScanDrafts(settings = {}) {
  if (settings.emergencyStop) return false;
  return true;
}

/**
 * Cap concurrency / batch size for scan prepare.
 * @param {number|undefined} requested
 */
export function clampScanPrepareMax(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return SCAN_PREPARE_DEFAULT_MAX;
  return Math.min(SCAN_PREPARE_HARD_MAX, Math.max(1, Math.floor(n)));
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {object} deps.api
 * @param {ReturnType<import('../telegram/mutation-request.js').createMutationRequester>|null} [deps.mutations]
 * @param {object|null} [deps.llm]
 * @param {ReturnType<import('./room-state.js').createRoomState>|null} [deps.roomState]
 * @param {ReturnType<import('../worker/queue.js').createJobQueue>|null} [deps.queue]
 */
export function createScanPrepare(deps) {
  const {
    db,
    api,
    mutations = null,
    llm = null,
    roomState: roomStateIn = null,
    queue = null,
    budget = null,
  } = deps;

  function llmWithinBudget() {
    if (!llm) return null;
    if (budget && typeof budget.decide === 'function') {
      try {
        if (budget.decide({ intent: 'draft_chat_reply', estimatedTokens: 3000 }) === 'budget_exceeded') return null;
      } catch {
        /* ignore */
      }
    }
    return llm;
  }

  const roomState = roomStateIn || createRoomState(db);
  const settingsStore = createAgentSettingsStore(db);

  /**
   * Prepare drafts + HITL for scan hits.
   * @param {{
   *   priorityRooms?: object[],
   *   matched?: object[],
   *   max?: number,
   *   force?: boolean,
   *   skipModeCheck?: boolean,
   * }} [input]
   */
  async function prepareScanHits(input = {}) {
    const settings = settingsStore.get();
    const auto = shouldAutoPrepareScanDrafts(settings);
    if (!input.force && !input.skipModeCheck && !auto) {
      return {
        ok: true,
        skipped: true,
        reason: 'mode_manual',
        prepareMode: 'manual_offer',
        preparedCount: 0,
        replyApprovals: 0,
        bidApprovals: 0,
        failed: 0,
        items: [],
      };
    }

    if (!mutations) {
      return {
        ok: false,
        error: 'mutations_unavailable',
        prepareMode: auto ? 'auto' : 'forced',
        preparedCount: 0,
        replyApprovals: 0,
        bidApprovals: 0,
        failed: 0,
        items: [],
      };
    }

    const max = clampScanPrepareMax(input.max);
    const rooms = pickRoomsToPrepare(input.priorityRooms || [], input.matched || [], max);
    const matchedByRoom = new Map(
      (input.matched || []).map((m) => [String(m.roomId), m])
    );

    const items = [];
    let replyApprovals = 0;
    let bidApprovals = 0;
    let failed = 0;

    for (const room of rooms) {
      const roomId = String(room.roomId ?? room.id);
      try {
        if (hasPendingSendForRoom(queue, roomId)) {
          items.push({ roomId, kind: 'reply', status: 'already_pending' });
          continue;
        }

        const invite = matchedByRoom.get(roomId) || null;
        const skip = scanSkipReason({ room, invite, roomState, roomId, force: Boolean(input.force) });
        if (skip) {
          items.push({ roomId, kind: 'reply', status: 'skipped', reason: skip });
          continue;
        }
        // Prefer chat reply prepare; if invite-only with project and little chat signal, also bid
        const replyOut = await prepareRoomReply(room, invite);
        items.push(replyOut);
        if (replyOut.status === 'approval_queued') replyApprovals += 1;
        else if (replyOut.status === 'failed') failed += 1;

        if (invite?.projectId) {
          const bidOut = await prepareInviteBid(invite);
          items.push(bidOut);
          if (bidOut.status === 'approval_queued') bidApprovals += 1;
          else if (bidOut.status === 'failed') failed += 1;
          else if (bidOut.status === 'already_pending') {
            /* ignore */
          }
        }
      } catch (e) {
        failed += 1;
        logger.warn('scan_prepare_room_failed', { roomId, err: e.message });
        items.push({ roomId, kind: 'reply', status: 'failed', error: e.message });
      }
    }

    const preparedCount = replyApprovals + bidApprovals;
    memoryAppend(db, {
      kind: 'scan_prepare',
      refId: 'scan',
      content: `prepared=${preparedCount} reply=${replyApprovals} bid=${bidApprovals} failed=${failed}`,
      meta: {
        max,
        roomCount: rooms.length,
        prepareMode: input.force && !auto ? 'forced' : auto ? 'auto' : 'manual_offer',
      },
    });

    return {
      ok: true,
      skipped: false,
      prepareMode: input.force && !auto ? 'forced' : 'auto',
      preparedCount,
      replyApprovals,
      bidApprovals,
      failed,
      analyzed: rooms.length,
      items,
    };
  }

  async function prepareRoomReply(roomHint, invite) {
    const roomId = String(roomHint.roomId ?? roomHint.id);
    const data = await api.messages.list(roomId, { page: 1 });
    const ownUserId = await getOwnUserId({ api, db }).catch(() => null);
    const messages = sortChronological(markOwnMessages(data.messages || [], ownUserId));
    const guestName =
      data.roomMeta?.guestName ||
      roomHint.guest_name ||
      roomHint.guestName ||
      roomHint.title ||
      null;

    let project = invite?.project || null;
    let projectSlug =
      messages.map((m) => m.projectSlug).find(Boolean) ||
      extractProjectSlug(roomHint.last_message || roomHint.lastMessage || '') ||
      null;
    const projectId =
      invite?.projectId || messages.map((m) => m.projectId).find(Boolean) || null;

    if (!project && (projectSlug || projectId)) {
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
        logger.warn('scan_prepare_project_failed', { roomId, err: e.message });
      }
    }

    const price = suggestChatPrice(project || {}, {});
    const roomContext = {
      roomId,
      guestName,
      project,
      messages: messages.slice(-12),
      projectTitle: project?.title,
    };

    let analysis = null;
    try {
      analysis = await analyzeRoomWithLlm({ roomContext, llm: llmWithinBudget() });
    } catch (e) {
      analysis = { ok: false, reason: e.message, summary: 'خطا در تحلیل.' };
    }

    const existingNote = roomState.getNote(roomId)?.text || '';
    const thread = roomState.getThread(roomId);
    const internal = [];
    if (analysis?.data?.estimated_days) {
      internal.push(`زمان تخمینی تحلیل: حدود ${Number(analysis.data.estimated_days).toLocaleString('fa-IR')} روز کاری.`);
    }
    if (price?.amount) {
      internal.push(`قیمت پیشنهادی داخلی: ${price.labelFa} (در متن نیاور مگر کارفرما بپرسد).`);
    }
    internal.push('پاسخ را کوتاه، انسانی و فارسی بنویس.');

    const template = buildDraftReply({
      ...roomContext,
      ownerNote: existingNote,
      proposal: {},
      includePrice: false,
    });

    const adapted = await adaptDraftWithNote({
      roomContext,
      currentDraft: roomState.getDraft(roomId)?.text || template.text,
      ownerNote: existingNote,
      internalNote: internal.join('\n'),
      llm: llmWithinBudget(),
      mode: 'analyze',
      analysis,
      pricing: price?.amount ? { amount: price.amount, currency: 'تومان', labelFa: price.labelFa } : null,
    });

    const draftText = cleanHumanReply(adapted.text || template.text);
    if (!String(draftText).trim()) {
      return { roomId, kind: 'reply', status: 'empty_draft', guestName };
    }

    roomState.setDraft(roomId, {
      text: draftText,
      source: adapted.llmUsed ? 'llm_scan_prepare' : 'template_scan_prepare',
      meta: { price, analysisOk: Boolean(analysis?.ok), fromScan: true },
    });
    roomState.setThread(roomId, {
      lastDraftText: draftText,
      suggestedPrice: price?.amount ?? null,
      summary: analysis?.summary || thread?.summary,
      phase: thread?.phase === 'answered' || thread?.phase === 'active_thread' ? 'active_thread' : 'pending',
    });
    roomState.setDecision(roomId, { status: 'pending', detail: 'scan_prepare' });
    roomState.setCard(roomId, {
      roomId,
      guestName,
      project: project
        ? {
            id: project.id,
            title: project.title,
            minBudget: project.minBudget,
            maxBudget: project.maxBudget,
          }
        : null,
      messages: messages.slice(-8).map((m) => ({
        id: m.id,
        text: m.text,
        isOwn: m.isOwn,
        createdAt: m.createdAt,
      })),
      draftText,
      analysisSummary: analysis?.summary || null,
      continuumAction: 'scan_hitl',
      pickPrompt: true,
      decisionStatus: 'pending',
      suggestedPriceFa: price?.labelFa || null,
    });

    const out = mutations.request({
      action: 'messages.send',
      payload: {
        roomId,
        text: draftText,
        risk: 'high',
        aiReason: analysis?.summary
          ? `اسکن: ${String(analysis.summary).slice(0, 120)}`
          : 'پیش‌نویس پاسخ پس از اسکن — منتظر تأیید شما',
      },
      gateCtx: {
        source: 'scan_prepare',
        roomId,
        text: draftText,
        riskHint: 'high',
        matchScore: analysis?.data?.matchScore,
      },
      requestedBy: 'scan_prepare',
      targetRef: roomId,
      operationId: `scan-reply:${roomId}:${Date.now()}`,
      idempotencyKey: `scan-reply:${roomId}:${hashShort(draftText)}`,
      forceRequireApproval: true,
    });

    if (out.denied) {
      return {
        roomId,
        kind: 'reply',
        status: 'denied',
        guestName,
        reason: out.verdict?.reasonFa || out.verdict?.reason,
      };
    }
    if (out.error) {
      return { roomId, kind: 'reply', status: 'failed', guestName, error: out.error };
    }

    return {
      roomId,
      kind: 'reply',
      status: 'approval_queued',
      guestName,
      approvalId: out.approval?.approval_id || null,
      llmUsed: Boolean(adapted.llmUsed),
    };
  }

  async function prepareInviteBid(invite) {
    const projectId = String(invite.projectId);
    if (hasPendingBidForProject(queue, projectId)) {
      return { projectId, kind: 'bid', status: 'already_pending' };
    }

    let project = invite.project || null;
    if (!project) {
      try {
        const got = await api.projects.get(projectId);
        project = got.project;
      } catch (e) {
        logger.warn('scan_prepare_bid_project_failed', { projectId, err: e.message });
      }
    }

    let profile = {};
    try {
      profile = createOpportunityStore(db).getScoringProfile() || {};
    } catch {
      profile = {};
    }

    const opp = {
      id: projectId,
      title: project?.title || invite.inviteText || '',
      skills: project?.skills || [],
      category: project?.category,
      budgetMin: project?.minBudget ?? project?.budgetMin,
      budgetMax: project?.maxBudget ?? project?.budgetMax,
      source: 'invite',
      roomId: invite.roomId,
    };

    const smart = buildSmartBid(opp, profile, {
      ownerNote: 'پیشنهاد از مسیر اسکن دعوت — فقط پس از تأیید ارسال شود.',
    });

    const out = mutations.request({
      action: 'bids.submit',
      payload: {
        projectId,
        proposalText: smart.text,
        price: smart.price ?? opp.budgetMin ?? 1_000_000,
        days: smart.days ?? 7,
        smartBid: true,
        fromScan: true,
        roomId: invite.roomId != null ? String(invite.roomId) : null,
        aiReason: 'پیشنهاد هوشمند پس از اسکن دعوت — منتظر تأیید شما',
      },
      gateCtx: {
        source: 'scan_prepare',
        projectId,
        roomId: invite.roomId,
        riskHint: 'high',
        hasExistingBid: false,
      },
      requestedBy: 'scan_prepare',
      targetRef: projectId,
      operationId: `scan-bid:${projectId}:${Date.now()}`,
      idempotencyKey: `scan-bid:${projectId}:${hashShort(smart.text)}`,
      forceRequireApproval: true,
    });

    if (out.denied) {
      return {
        projectId,
        kind: 'bid',
        status: 'denied',
        reason: out.verdict?.reasonFa || out.verdict?.reason,
      };
    }
    if (out.error) {
      return { projectId, kind: 'bid', status: 'failed', error: out.error };
    }

    return {
      projectId,
      roomId: invite.roomId,
      kind: 'bid',
      status: 'approval_queued',
      approvalId: out.approval?.approval_id || null,
    };
  }

  return {
    prepareScanHits,
    shouldAutoPrepare: () => shouldAutoPrepareScanDrafts(settingsStore.get()),
    getSettings: () => settingsStore.get(),
  };
}

/**
 * Merge priority rooms + matched invites; prefer unread / keyword; unique by roomId.
 */
export function pickRoomsToPrepare(priorityRooms = [], matched = [], max = SCAN_PREPARE_DEFAULT_MAX) {
  const byId = new Map();
  for (const r of priorityRooms) {
    const id = String(r.roomId ?? r.id ?? '');
    if (!id) continue;
    byId.set(id, { ...r, roomId: id });
  }
  for (const m of matched) {
    const id = String(m.roomId ?? '');
    if (!id) continue;
    const prev = byId.get(id) || { roomId: id };
    byId.set(id, {
      ...prev,
      roomId: id,
      keywordMatched: true,
      projectId: m.projectId ?? prev.projectId,
      reason: prev.reason || 'تطابق کلیدواژه',
    });
  }
  const list = [...byId.values()].sort((a, b) => {
    const au = Number(a.unread) > 0 ? 1 : 0;
    const bu = Number(b.unread) > 0 ? 1 : 0;
    if (bu !== au) return bu - au;
    const ak = a.keywordMatched || a.matched ? 1 : 0;
    const bk = b.keywordMatched || b.matched ? 1 : 0;
    if (bk !== ak) return bk - ak;
    return 0;
  });
  return list.slice(0, max);
}

/** Chat-continuum actions that already produced a card / send for the latest inbound. */
const CONTINUUM_HANDLED = new Set(['auto_hitl', 'pick_to_answer', 'auto_sent', 'hitl_emergency', 'scan_hitl', 'price_ask']);

/**
 * Why scan-prepare should NOT draft this room (null → prepare).
 * - already answered / sending with no newer inbound
 * - no fresh inbound (unread 0) unless it is a matched invite
 * - chat continuum already made a card/send for the latest inbound
 * @returns {string|null}
 */
export function scanSkipReason({ room = {}, invite = null, roomState, roomId, force = false }) {
  if (!roomState) return null;
  const decision = roomState.getDecision(roomId);
  const thread = roomState.getThread(roomId);
  if (decision?.status === 'sending') return 'sending';
  const sentAt = Date.parse(thread.lastSentAt || '');
  const inboundAt = Date.parse(thread.lastInboundAt || '');
  const unread = Number(room.unread) || 0;
  if (
    (decision?.status === 'answered' || Number.isFinite(sentAt)) &&
    unread <= 0 &&
    (!Number.isFinite(inboundAt) || !Number.isFinite(sentAt) || inboundAt <= sentAt)
  ) {
    return 'already_answered';
  }
  if (!force && unread <= 0 && !invite) return 'no_fresh_inbound';
  const card = roomState.getCard(roomId);
  if (
    decision?.status === 'pending' &&
    card &&
    CONTINUUM_HANDLED.has(String(card.continuumAction || '')) &&
    (!Number.isFinite(inboundAt) || Date.parse(decision.updatedAt || '') >= inboundAt)
  ) {
    return 'already_carded';
  }
  return null;
}

function hasPendingSendForRoom(queue, roomId) {
  if (!queue?.pendingApprovals) return false;
  const id = String(roomId);
  return (queue.pendingApprovals() || []).some((a) => {
    if (a.action && a.action !== 'messages.send') return false;
    try {
      const p = typeof a.payload_json === 'string' ? JSON.parse(a.payload_json) : a.payload || {};
      return String(p.roomId) === id;
    } catch {
      return String(a.target_ref) === id;
    }
  });
}

function hasPendingBidForProject(queue, projectId) {
  if (!queue?.pendingApprovals) return false;
  const id = String(projectId);
  return (queue.pendingApprovals() || []).some((a) => {
    if (a.action && a.action !== 'bids.submit') return false;
    try {
      const p = typeof a.payload_json === 'string' ? JSON.parse(a.payload_json) : a.payload || {};
      return String(p.projectId) === id;
    } catch {
      return String(a.target_ref) === id;
    }
  });
}

function hashShort(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 12);
}

export default createScanPrepare;
