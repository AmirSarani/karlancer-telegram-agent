/**
 * Mode-aware chat engagement continuum after new inbound detection.
 *
 * full_manual     → notify only (optional light summary); no auto LLM / send
 * pick_to_answer  → LLM analyze + draft + price → pick card «جواب بدم؟»
 * full_auto       → LLM + PermissionGate + daily limits + live flags → send or HITL
 *
 * Never unlimited. Reuses analyzeRoomWithLlm, adaptDraftWithNote, cleanHumanReply,
 * PermissionGate, mutation requester, VerifiedMutationContract path.
 */
import { analyzeRoomWithLlm, adaptDraftWithNote } from './analyze-llm.js';
import { cleanHumanReply } from './reply-clean.js';
import { buildDraftReply } from './draft-api.js';
import { suggestChatPrice } from './chat-price.js';
import { createAgentSettingsStore } from '../telegram/agent-settings.js';
import { logger } from '../observability/logger.js';

export const CHAT_AI_MODE_LABELS_FA = Object.freeze({
  full_manual: 'کاملاً دستی',
  pick_to_answer: 'انتخابی',
  full_auto: 'خودکار',
});

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<import('./room-state.js').createRoomState>} deps.roomState
 * @param {object|null} [deps.llm]
 * @param {ReturnType<import('../telegram/permission-gate.js').createPermissionGate>|null} [deps.gate]
 * @param {ReturnType<import('../telegram/mutation-request.js').createMutationRequester>|null} [deps.mutations]
 * @param {() => boolean} [deps.getAllowLiveAutoSend]
 * @param {object|null} [deps.scoringProfile]
 */
export function createChatContinuum(deps) {
  const {
    db,
    roomState,
    llm = null,
    gate = null,
    mutations = null,
    getAllowLiveAutoSend = () => false,
    scoringProfile = null,
  } = deps;

  const settingsStore = db ? createAgentSettingsStore(db) : null;

  /**
   * Process one inbound card according to chatAiMode.
   * Mutates roomState (draft/thread/card) and may enqueue send via mutations.
   *
   * @param {object} card — poll card
   * @param {{ forceMode?: string }} [opts]
   */
  async function processInboundCard(card, opts = {}) {
    const roomId = String(card.roomId ?? card.id);
    const settings = settingsStore?.get?.() || { chatAiMode: 'full_manual' };
    const mode = opts.forceMode || settings.chatAiMode || 'full_manual';
    const threadBefore = roomState.getThread(roomId);
    const isContinuum =
      threadBefore.phase === 'answered' ||
      threadBefore.phase === 'active_thread' ||
      Boolean(threadBefore.lastSentAt);

    roomState.touchInbound(roomId);

    const price = suggestChatPrice(card.project || {}, scoringProfile || {});
    const base = {
      roomId,
      mode,
      modeFa: CHAT_AI_MODE_LABELS_FA[mode] || mode,
      isContinuum,
      price,
      analysis: null,
      draftText: card.draftText || roomState.getDraft(roomId)?.text || '',
      continuumAction: 'notify',
      autoSend: null,
      pickPrompt: false,
    };

    if (mode === 'full_manual') {
      return finalizeManual(card, base, threadBefore);
    }

    if (mode === 'pick_to_answer') {
      return finalizePick(card, base, threadBefore);
    }

    if (mode === 'full_auto') {
      return finalizeAuto(card, base, threadBefore, settings);
    }

    return finalizeManual(card, base, threadBefore);
  }

  async function finalizeManual(card, base, threadBefore) {
    // Optional light summary only when continuum (prior thread) — still no auto-send
    let summary = null;
    if (base.isContinuum && llm) {
      try {
        const analysis = await analyzeRoomWithLlm({
          roomContext: {
            project: card.project,
            guestName: card.guestName,
            messages: card.messages,
            prior: threadContext(threadBefore),
          },
          llm,
        });
        summary = analysis?.summary || null;
        base.analysis = analysis;
      } catch (e) {
        logger.warn('chat_continuum_manual_summary_failed', { roomId: base.roomId, err: e.message });
      }
    }

    const enriched = enrichCard(card, {
      ...base,
      continuumAction: base.isContinuum ? 'continuum_notify' : 'notify_only',
      lightSummary: summary,
      pickPrompt: false,
    });
    roomState.setCard(base.roomId, enriched);
    return enriched;
  }

  async function finalizePick(card, base, threadBefore) {
    const { analysis, draftText, llmUsed } = await runLlmPipeline(card, threadBefore, base.price, {
      includePriceInDraft: false,
    });
    roomState.setDraft(base.roomId, {
      text: draftText,
      source: llmUsed ? 'llm_continuum' : 'template_continuum',
      meta: { price: base.price, analysisOk: Boolean(analysis?.ok) },
    });
    roomState.setThread(base.roomId, {
      lastDraftText: draftText,
      suggestedPrice: base.price.amount,
      summary: analysis?.summary || threadBefore.summary,
      phase: base.isContinuum ? 'active_thread' : 'pending',
    });
    roomState.setDecision(base.roomId, { status: 'pending', detail: 'pick_to_answer' });

    const enriched = enrichCard(card, {
      ...base,
      analysis,
      draftText,
      continuumAction: 'pick_to_answer',
      pickPrompt: true,
      llmUsed,
    });
    roomState.setCard(base.roomId, enriched);
    return enriched;
  }

  async function finalizeAuto(card, base, threadBefore, settings) {
    if (settings.emergencyStop) {
      const fallback = await finalizePick(card, { ...base, mode: 'pick_to_answer' }, threadBefore);
      return { ...fallback, continuumAction: 'hitl_emergency', pickPrompt: true };
    }

    const { analysis, draftText, llmUsed } = await runLlmPipeline(card, threadBefore, base.price, {
      includePriceInDraft: true,
    });
    roomState.setDraft(base.roomId, {
      text: draftText,
      source: llmUsed ? 'llm_auto' : 'template_auto',
      meta: { price: base.price },
    });
    roomState.setThread(base.roomId, {
      lastDraftText: draftText,
      suggestedPrice: base.price.amount,
      summary: analysis?.summary || threadBefore.summary,
      phase: base.isContinuum ? 'active_thread' : 'pending',
    });

    const liveOk = Boolean(getAllowLiveAutoSend());
    const gateCtx = {
      source: 'auto',
      roomId: base.roomId,
      text: draftText,
      riskHint: 'high',
      matchScore: analysis?.data?.matchScore,
    };

    let verdict = null;
    if (gate) {
      verdict = gate.check('messages.send', gateCtx);
    }

    const needsHitl =
      !liveOk ||
      !mutations ||
      !verdict ||
      verdict.decision !== 'auto_allow' ||
      verdict.showCard;

    if (needsHitl) {
      roomState.setDecision(base.roomId, {
        status: 'pending',
        detail: !liveOk
          ? 'live_auto_send_off'
          : verdict?.reason || 'require_approval',
      });
      const enriched = enrichCard(card, {
        ...base,
        analysis,
        draftText,
        continuumAction: 'auto_hitl',
        pickPrompt: true,
        llmUsed,
        gateVerdict: verdict
          ? { decision: verdict.decision, reason: verdict.reason, reasonFa: verdict.reasonFa }
          : null,
        liveAutoSend: liveOk,
      });
      roomState.setCard(base.roomId, enriched);
      return enriched;
    }

    // Auto-send path (still through mutation requester → VerifiedMutationContract)
    try {
      const out = mutations.request({
        action: 'messages.send',
        payload: {
          roomId: base.roomId,
          text: draftText,
          risk: 'high',
          aiReason: 'پاسخ خودکار چت (full_auto + gate)',
        },
        gateCtx: { ...gateCtx, source: 'auto' },
        requestedBy: 'chat_continuum:full_auto',
        targetRef: base.roomId,
        operationId: `chat-auto:${base.roomId}:${Date.now()}`,
        idempotencyKey: `chat-auto:${base.roomId}:${hashShort(draftText)}`,
      });

      if (out.denied || out.error || out.pendingApproval) {
        roomState.setDecision(base.roomId, {
          status: 'pending',
          detail: out.denied ? 'gate_denied' : out.error || 'pending_approval',
        });
        const enriched = enrichCard(card, {
          ...base,
          analysis,
          draftText,
          continuumAction: 'auto_hitl',
          pickPrompt: true,
          llmUsed,
          autoSend: { ok: false, detail: out.denied ? 'denied' : out.error || 'pending' },
        });
        roomState.setCard(base.roomId, enriched);
        return enriched;
      }

      roomState.markAnswered(base.roomId, {
        lastSentText: draftText,
        summary: analysis?.summary || null,
      });
      const enriched = enrichCard(card, {
        ...base,
        analysis,
        draftText,
        continuumAction: 'auto_sent',
        pickPrompt: false,
        llmUsed,
        autoSend: { ok: true, jobId: out.job?.jobId || out.job?.id || null },
        decisionStatus: 'answered',
      });
      roomState.setCard(base.roomId, enriched);
      return enriched;
    } catch (e) {
      logger.warn('chat_continuum_auto_send_failed', { roomId: base.roomId, err: e.message });
      const enriched = enrichCard(card, {
        ...base,
        analysis,
        draftText,
        continuumAction: 'auto_hitl',
        pickPrompt: true,
        llmUsed,
        autoSend: { ok: false, detail: e.message },
      });
      roomState.setCard(base.roomId, enriched);
      return enriched;
    }
  }

  async function runLlmPipeline(card, threadBefore, price, { includePriceInDraft }) {
    const roomContext = {
      roomId: card.roomId,
      guestName: card.guestName,
      project: card.project,
      messages: card.messages,
      projectTitle: card.project?.title,
      prior: threadContext(threadBefore),
    };

    let analysis = null;
    try {
      analysis = await analyzeRoomWithLlm({ roomContext, llm });
    } catch (e) {
      analysis = { ok: false, reason: e.message, summary: 'خطا در تحلیل.' };
    }

    const ownerNoteParts = [];
    const existingNote = roomState.getNote(card.roomId)?.text;
    if (existingNote) ownerNoteParts.push(existingNote);
    if (threadBefore.lastSentText) {
      ownerNoteParts.push(
        `پیام قبلی ما: ${String(threadBefore.lastSentText).slice(0, 400)}`
      );
    }
    if (threadBefore.summary) {
      ownerNoteParts.push(`خلاصه قبلی: ${String(threadBefore.summary).slice(0, 300)}`);
    }
    if (price?.amount && includePriceInDraft) {
      ownerNoteParts.push(
        `قیمت پیشنهادی داخلی حدود ${price.labelFa} است؛ اگر مناسب بود طبیعی در پاسخ بگنجان.`
      );
    } else if (price?.amount) {
      ownerNoteParts.push(
        `قیمت پیشنهادی داخلی: ${price.labelFa} (در متن نیاور مگر کارفرما بپرسد).`
      );
    }
    ownerNoteParts.push('پاسخ را کوتاه، انسانی و فارسی بنویس.');

    const currentDraft =
      roomState.getDraft(card.roomId)?.text ||
      card.draftText ||
      buildDraftReply({
        ...roomContext,
        ownerNote: '',
        proposal: includePriceInDraft && price?.amount ? { price: price.amount } : {},
        includePrice: Boolean(includePriceInDraft && price?.amount),
      }).text;

    const adapted = await adaptDraftWithNote({
      roomContext,
      currentDraft,
      ownerNote: ownerNoteParts.join('\n'),
      llm,
      mode: 'analyze',
    });

    return {
      analysis,
      draftText: cleanHumanReply(adapted.text || currentDraft),
      llmUsed: Boolean(adapted.llmUsed),
    };
  }

  function threadContext(thread) {
    if (!thread) return null;
    return {
      phase: thread.phase,
      summary: thread.summary,
      lastSentText: thread.lastSentText,
      lastDraftText: thread.lastDraftText,
      lastSentAt: thread.lastSentAt,
      lastInboundAt: thread.lastInboundAt,
      notes: thread.notes,
      suggestedPrice: thread.suggestedPrice,
    };
  }

  function enrichCard(card, extra) {
    return {
      ...card,
      draftText: extra.draftText ?? card.draftText,
      chatAiMode: extra.mode,
      chatAiModeFa: extra.modeFa,
      isContinuum: extra.isContinuum,
      continuumAction: extra.continuumAction,
      pickPrompt: Boolean(extra.pickPrompt),
      suggestedPrice: extra.price?.amount ?? null,
      suggestedPriceFa: extra.price?.labelFa ?? null,
      analysisSummary: extra.analysis?.summary || extra.lightSummary || null,
      llmUsed: Boolean(extra.llmUsed),
      autoSend: extra.autoSend || null,
      gateVerdict: extra.gateVerdict || null,
      liveAutoSend: extra.liveAutoSend,
      decisionStatus: extra.decisionStatus || card.decisionStatus || 'pending',
      threadPhase: roomState.getThread(String(card.roomId ?? card.id)).phase,
    };
  }

  /**
   * Batch: run continuum for each new inbound card from poll.
   */
  async function processPollCards(cards = []) {
    const out = [];
    for (const card of cards) {
      try {
        out.push(await processInboundCard(card));
      } catch (e) {
        logger.warn('chat_continuum_card_failed', {
          roomId: card?.roomId,
          err: e.message,
        });
        out.push(card);
      }
    }
    return out;
  }

  return {
    processInboundCard,
    processPollCards,
    getMode() {
      return settingsStore?.get?.()?.chatAiMode || 'full_manual';
    },
  };
}

function hashShort(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 12);
}

export default createChatContinuum;
