/**
 * Phase D — scheduled polite follow-up.
 *
 * Room answered, no client reply for `followUp.afterHours` (default 24h) → draft a short, polite
 * follow-up (max `followUp.maxPerRoom`, 1–2) and send it through the SAME path as any chat send:
 * mutation requester → PermissionGate → approval / VerifiedMutationContract.
 * HITL (owner approval) unless chat mode is full_auto, live auto-send is allowed and the gate allows it.
 */
import { hasPendingSendForRoom } from './scan-prepare.js';
import { buildConversationHistory } from './conversation.js';
import { cleanHumanReply } from './reply-clean.js';
import { createAgentSettingsStore } from '../telegram/agent-settings.js';
import { logger } from '../observability/logger.js';

const HOUR = 3_600_000;

/**
 * @returns {string|null} reason to skip, or null when a follow-up is due
 */
export function followUpSkipReason({ thread, decision, cfg, now = Date.now(), pendingSend = false }) {
  if (!cfg?.enabled) return 'disabled';
  if ((Number(cfg.maxPerRoom) || 0) <= 0) return 'disabled';
  if (pendingSend) return 'pending_send';
  if (decision?.status === 'sending') return 'sending';
  const sentAt = Date.parse(thread?.lastSentAt || '');
  if (!Number.isFinite(sentAt)) return 'never_answered';
  const inboundAt = Date.parse(thread?.lastInboundAt || '');
  if (Number.isFinite(inboundAt) && inboundAt > sentAt) return 'client_replied';
  if ((Number(thread?.followUpCount) || 0) >= Number(cfg.maxPerRoom)) return 'max_reached';
  if (thread?.followUpDraftedFor && thread.followUpDraftedFor === thread.lastSentAt) return 'already_drafted';
  if (now - sentAt < (Number(cfg.afterHours) || 24) * HOUR) return 'not_yet';
  if (now - sentAt > (Number(cfg.maxAgeDays) || 7) * 24 * HOUR) return 'too_old';
  return null;
}

export function followUpTemplate(guestName) {
  const name = guestName ? ` ${String(guestName).slice(0, 40)}` : '';
  return [
    `سلام${name}، وقت بخیر.`,
    'خواستم ببینم فرصت کردید پیام قبلی‌ام را ببینید؟',
    'اگر سؤالی دارید یا جزئیات بیشتری لازم است، خوشحال می‌شوم کمک کنم.',
  ].join('\n');
}

const FOLLOW_UP_NOTE = [
  'این یک پیام پیگیری است: کارفرما به پیام قبلی ما جواب نداده.',
  'یک پیام کوتاه، مؤدبانه و بدون اصرار بنویس (حداکثر دو یا سه جمله).',
  'قیمت یا تخفیف جدید پیشنهاد نده و چیزی را که قبلاً گفتیم تکرار نکن.',
].join('\n');

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<import('./room-state.js').createRoomState>} deps.roomState
 * @param {object} [deps.queue]
 * @param {object} [deps.mutations]
 * @param {object|null} [deps.llm]
 * @param {{ decide: Function }|null} [deps.budget]
 * @param {() => boolean} [deps.getAllowLiveAutoSend]
 * @param {number} [deps.now]
 * @param {number} [deps.maxPerRun]
 */
export async function runFollowUpScan(deps) {
  const {
    db,
    roomState,
    queue = null,
    mutations = null,
    llm = null,
    budget = null,
    getAllowLiveAutoSend = () => false,
    now = Date.now(),
    maxPerRun = 3,
  } = deps;
  const settings = createAgentSettingsStore(db).get();
  const cfg = settings.followUp || {};
  const items = [];
  if (settings.emergencyStop) return { ok: true, items, skipped: 'emergency_stop' };
  if (!cfg.enabled) return { ok: true, items, skipped: 'disabled' };
  if (!mutations) return { ok: false, items, skipped: 'no_mutations' };

  let prepared = 0;
  for (const roomId of roomState.listAnsweredRoomIds()) {
    if (prepared >= maxPerRun) break;
    const thread = roomState.getThread(roomId);
    const decision = roomState.getDecision(roomId);
    const reason = followUpSkipReason({
      thread,
      decision,
      cfg,
      now,
      pendingSend: hasPendingSendForRoom(queue, roomId),
    });
    if (reason) {
      if (!['not_yet', 'max_reached', 'already_drafted'].includes(reason)) items.push({ roomId, status: 'skipped', reason });
      continue;
    }

    const card = roomState.getCard(roomId) || {};
    const draft = await draftFollowUp({ card, thread, llm, budget });
    const fullAuto = settings.chatAiMode === 'full_auto' && settings.mode === 'auto';
    const autoOk = fullAuto && Boolean(getAllowLiveAutoSend()) && draft.llmUsed;
    try {
      const out = mutations.request({
        action: 'messages.send',
        payload: {
          roomId: String(roomId),
          text: draft.text,
          risk: 'high',
          followUp: true,
          aiReason: 'پیگیری مودبانه پس از بی‌پاسخ ماندن',
          ...(card.clientUserId ? { receptorId: String(card.clientUserId) } : {}),
        },
        gateCtx: {
          source: autoOk ? 'auto' : 'followup',
          roomId: String(roomId),
          text: draft.text,
          clientText: lastClientText(card),
          riskHint: 'high',
          matchScore: draft.confidence != null ? Math.round(draft.confidence * 100) : undefined,
        },
        requestedBy: 'followup',
        targetRef: String(roomId),
        forceRequireApproval: !autoOk,
        operationId: `followup:${roomId}:${(Number(thread.followUpCount) || 0) + 1}`,
        idempotencyKey: `followup:${roomId}:${(Number(thread.followUpCount) || 0) + 1}:${thread.lastSentAt}`,
      });
      prepared += 1;
      // One draft per unanswered send, even if the owner rejects it.
      roomState.setThread(roomId, { followUpDraftedFor: thread.lastSentAt });
      if (out.pendingApproval) {
        roomState.setDraft(roomId, { text: draft.text, source: 'followup', meta: { followUp: true } });
      }
      items.push({
        roomId: String(roomId),
        guestName: card.guestName || null,
        status: out.denied ? 'denied' : out.pendingApproval ? 'pending_approval' : out.autoExecuted ? 'queued_auto' : out.error ? 'error' : 'queued',
        text: draft.text,
        llmUsed: draft.llmUsed,
      });
    } catch (e) {
      logger.warn('followup_request_failed', { roomId, err: e.message });
      items.push({ roomId: String(roomId), status: 'error', reason: e.message });
    }
  }
  return { ok: true, items };
}

function lastClientText(card) {
  const msgs = Array.isArray(card?.messages) ? card.messages : [];
  const last = [...msgs].reverse().find((m) => !m.isOwn);
  return last?.text ? String(last.text).slice(0, 500) : '';
}

async function draftFollowUp({ card, thread, llm, budget }) {
  const template = followUpTemplate(card.guestName);
  if (!llm || typeof llm.draftChatReply !== 'function') return { text: template, llmUsed: false, confidence: null };
  if (budget && typeof budget.decide === 'function') {
    try {
      if (budget.decide({ intent: 'draft_chat_reply', estimatedTokens: 1500 }) === 'budget_exceeded') {
        return { text: template, llmUsed: false, confidence: null };
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const history = buildConversationHistory(card.messages || []);
    const out = await llm.draftChatReply({
      roomContext: { guestName: card.guestName, project: card.project, projectTitle: card.project?.title },
      employerMessage: lastClientText(card) || '(کارفرما پاسخی نداده است)',
      history,
      internalNote: [FOLLOW_UP_NOTE, thread.lastSentText ? `پیام قبلی ما: ${String(thread.lastSentText).slice(0, 300)}` : ''].filter(Boolean).join('\n'),
    });
    if (!out?.ok || out.fallback || !out.data?.reply_text) return { text: template, llmUsed: false, confidence: null };
    return {
      text: cleanHumanReply(out.data.reply_text).slice(0, 800),
      llmUsed: true,
      confidence: Number.isFinite(Number(out.data.confidence)) ? Number(out.data.confidence) : null,
    };
  } catch {
    return { text: template, llmUsed: false, confidence: null };
  }
}

export default { runFollowUpScan, followUpSkipReason, followUpTemplate };
