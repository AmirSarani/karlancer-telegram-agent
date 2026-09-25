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
import { decideChatPrice } from './chat-price.js';
import { setRoomPriceAsk } from './price-memory.js';
import {
  buildConversationHistory,
  latestClientTurn,
  detectNegotiation,
  evaluateDiscount,
} from './conversation.js';
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
 * @param {{ decide: Function }|null} [deps.budget] TokenBudgetManager (DAILY_TOKEN_LIMIT)
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
    budget = null,
  } = deps;

  /** LLM for this call, or null when the daily token budget is exhausted. */
  function llmWithinBudget() {
    if (!llm) return { llm: null, budgetExceeded: false };
    if (budget && typeof budget.decide === 'function') {
      try {
        if (budget.decide({ intent: 'draft_chat_reply', estimatedTokens: 3000 }) === 'budget_exceeded') {
          return { llm: null, budgetExceeded: true };
        }
      } catch {
        /* ignore budget errors */
      }
    }
    return { llm, budgetExceeded: false };
  }

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

    const base = buildBase(card, roomId, mode, isContinuum);

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

  function buildBase(card, roomId, mode, isContinuum) {
    let clientText = '';
    try {
      clientText = latestClientTurn(buildConversationHistory(card.messages || [])).join('\n');
    } catch {
      clientText = '';
    }
    const price = decideChatPrice({ db, card: { ...card, roomId }, clientText, scoringProfile: scoringProfile || {} });
    return {
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
  }

  /**
   * Owner answered «چه قیمتی بدهم؟» → continue the auto path for this room with that price.
   * Still goes through the same safety checks + PermissionGate + mutation requester.
   */
  async function resumeAfterPrice(roomIdIn) {
    const roomId = String(roomIdIn);
    const card = roomState.getCard(roomId);
    if (!card) return { ok: false, reason: 'no_card' };
    const settings = settingsStore?.get?.() || { chatAiMode: 'full_manual' };
    if (settings.chatAiMode !== 'full_auto') return { ok: false, reason: 'mode_not_auto' };
    const threadBefore = roomState.getThread(roomId);
    const isContinuum = Boolean(threadBefore.lastSentAt);
    const base = buildBase(card, roomId, 'full_auto', isContinuum);
    const out = await finalizeAuto({ ...card, draftText: null }, base, threadBefore, settings, { resumed: true });
    return { ok: true, card: out };
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

  async function finalizeAuto(card, base, threadBefore, settings, autoOpts = {}) {
    if (settings.emergencyStop) {
      const fallback = await finalizePick(card, { ...base, mode: 'pick_to_answer' }, threadBefore);
      return { ...fallback, continuumAction: 'hitl_emergency', pickPrompt: true };
    }

    const pipe = await runLlmPipeline(card, threadBefore, base.price, {
      includePriceInDraft: true,
      settings,
    });
    const { analysis, draftText, llmUsed } = pipe;
    roomState.setDraft(base.roomId, {
      text: draftText,
      source: llmUsed ? 'llm_auto' : 'template_auto',
      meta: { price: base.price, fallback: pipe.fallback },
    });
    roomState.setThread(base.roomId, {
      lastDraftText: draftText,
      suggestedPrice: base.price.amount,
      summary: analysis?.summary || threadBefore.summary,
      phase: base.isContinuum ? 'active_thread' : 'pending',
    });

    const liveOk = Boolean(getAllowLiveAutoSend());
    const confidence = pipe.confidence;
    const gateCtx = {
      source: 'auto',
      roomId: base.roomId,
      text: draftText,
      clientText: pipe.clientText,
      riskHint: 'high',
      matchScore: confidence != null ? Math.round(confidence * 100) : undefined,
      confidence,
      budget: card.project?.maxBudget ?? card.project?.minBudget ?? base.price?.amount ?? undefined,
    };

    const safety = autoSafetyCheck(pipe, settings);

    if (shouldAskOwnerPrice({ price: base.price, pipe, safety, card, isContinuum: base.isContinuum })) {
      return finalizePriceAsk(card, base, pipe);
    }

    let verdict = null;
    if (gate && !safety) {
      verdict = gate.check('messages.send', gateCtx);
    }

    const needsHitl =
      !liveOk ||
      Boolean(safety) ||
      !mutations ||
      !verdict ||
      verdict.decision !== 'auto_allow' ||
      verdict.showCard;

    if (needsHitl) {
      if (liveOk && verdict && verdict.reason === 'auto_preview_card' && typeof gate?.recordDecision === 'function') {
        try {
          gate.recordDecision('messages.send', verdict, {
            actor: 'chat_continuum:preview',
            roomId: base.roomId,
          });
        } catch {
          /* ignore audit errors */
        }
      }
      roomState.setDecision(base.roomId, {
        status: 'pending',
        detail: !liveOk
          ? 'live_auto_send_off'
          : safety?.reason || verdict?.reason || 'require_approval',
      });
      const enriched = enrichCard(card, {
        ...base,
        analysis,
        draftText,
        continuumAction: 'auto_hitl',
        pickPrompt: true,
        llmUsed,
        gateVerdict: safety
          ? { decision: 'require_approval', reason: safety.reason, reasonFa: safety.reasonFa }
          : verdict
            ? { decision: verdict.decision, reason: verdict.reason, reasonFa: verdict.reasonFa }
            : !liveOk
              ? { decision: 'require_approval', reason: 'live_auto_send_off', reasonFa: 'ارسال خودکار زنده خاموش است' }
              : null,
        liveAutoSend: liveOk,
        negotiation: pipe.negotiation,
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
          ...(card.clientUserId ? { receptorId: String(card.clientUserId) } : {}),
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

      // Answered only after the worker's POST succeeds (handlers.js messages.send → markAnswered).
      const jobId = out.job?.jobId || out.job?.id || null;
      roomState.setDecision(base.roomId, { status: 'sending', detail: jobId });
      roomState.setThread(base.roomId, {
        pendingSendJobId: jobId,
        summary: analysis?.summary || threadBefore.summary,
      });
      const enriched = enrichCard(card, {
        ...base,
        analysis,
        draftText,
        continuumAction: 'auto_sent',
        pickPrompt: false,
        llmUsed,
        autoSend: { ok: true, jobId, queued: true },
        decisionStatus: 'sending',
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

  async function runLlmPipeline(card, threadBefore, price, { includePriceInDraft, settings = null }) {
    const history = buildConversationHistory(card.messages || []);
    const clientTurn = latestClientTurn(history);
    const clientText = clientTurn.join('\n');
    const roomContext = {
      roomId: card.roomId,
      guestName: card.guestName,
      project: card.project,
      messages: card.messages,
      history,
      projectTitle: card.project?.title,
      prior: threadContext(threadBefore),
    };

    const { llm: effLlm, budgetExceeded } = llmWithinBudget();
    let analysis = null;
    try {
      analysis = await analyzeRoomWithLlm({ roomContext, llm: effLlm });
    } catch (e) {
      analysis = { ok: false, reason: e.message, summary: 'خطا در تحلیل.' };
    }

    const s = settings || settingsStore?.get?.() || {};
    const negotiation = detectNegotiation(clientText);
    const discount = evaluateDiscount(negotiation, {
      basePrice: price?.amount ?? threadBefore.suggestedPrice ?? null,
      maxDiscountPct: s.pricing?.maxDiscountPct,
      priceFloorToman: s.pricing?.priceFloorToman,
    });

    const internal = [];
    if (threadBefore.summary) {
      internal.push(`خلاصهٔ قبلی گفتگو: ${String(threadBefore.summary).slice(0, 300)}`);
    }
    const days = analysis?.data?.estimated_days;
    if (days) internal.push(`زمان تخمینی تحلیل: حدود ${Number(days).toLocaleString('fa-IR')} روز کاری.`);
    if (price?.amount && includePriceInDraft) {
      internal.push(
        `قیمت پیشنهادی داخلی حدود ${price.labelFa} است؛ فقط اگر کارفرما قیمت خواست بگو.`
      );
    } else if (price?.amount) {
      internal.push(`قیمت پیشنهادی داخلی: ${price.labelFa} (در متن نیاور مگر کارفرما بپرسد).`);
    }
    if (negotiation.askedDiscount) {
      internal.push(
        discount.needsOwner
          ? 'کارفرما تخفیف بیشتر از سقف خواسته؛ قول تخفیف نده و بگو بررسی می‌کنی.'
          : `سقف تخفیف مجاز ${discount.maxPct}٪ است${discount.minPrice ? ` و کف قیمت ${formatTomanFa(discount.minPrice)}` : ''}.`
      );
    }
    internal.push('پاسخ را کوتاه، انسانی و فارسی بنویس.');

    const ownerNote = roomState.getNote(card.roomId)?.text || '';
    const currentDraft =
      card.draftText ||
      roomState.getDraft(card.roomId)?.text ||
      buildDraftReply({
        ...roomContext,
        ownerNote: '',
        proposal: includePriceInDraft && price?.amount ? { price: price.amount } : {},
        includePrice: Boolean(includePriceInDraft && price?.amount),
      }).text;

    const adapted = await adaptDraftWithNote({
      roomContext,
      currentDraft,
      ownerNote,
      internalNote: internal.join('\n'),
      llm: effLlm,
      mode: 'analyze',
      analysis,
      pricing: price?.amount
        ? { amount: price.amount, currency: 'تومان', labelFa: price.labelFa, source: price.source }
        : null,
      negotiation: {
        ...negotiation,
        maxDiscountPct: discount.maxPct,
        minPrice: discount.minPrice,
      },
    });

    const analysisConf = analysis?.ok ? Number(analysis.confidence ?? analysis.data?.confidence) : null;
    const draftConf = adapted.llmUsed && adapted.confidence != null ? Number(adapted.confidence) : null;
    const confidence =
      analysisConf != null && Number.isFinite(analysisConf)
        ? draftConf != null && Number.isFinite(draftConf)
          ? Math.min(analysisConf, draftConf)
          : analysisConf
        : null;

    return {
      analysis,
      draftText: cleanHumanReply(adapted.text || currentDraft),
      llmUsed: Boolean(adapted.llmUsed),
      fallback: adapted.fallback !== false || !adapted.llmUsed,
      confidence,
      clientText,
      negotiation,
      discount,
      budgetExceeded,
    };
  }

  function finalizePriceAsk(card, base, pipe) {
    const price = base.price || {};
    if (db) {
      setRoomPriceAsk(db, base.roomId, {
        suggested: price.amount ?? null,
        basedOnN: price.basedOnN || 0,
        source: price.source || null,
        features: price.features || null,
      });
    }
    roomState.setDecision(base.roomId, { status: 'pending', detail: 'price_ask' });
    const enriched = enrichCard(card, {
      ...base,
      analysis: pipe.analysis,
      draftText: pipe.draftText,
      continuumAction: 'price_ask',
      pickPrompt: false,
      llmUsed: pipe.llmUsed,
      priceAsk: {
        suggested: price.amount ?? null,
        suggestedFa: price.labelFa ?? null,
        basedOnN: price.basedOnN || 0,
        firstTimeType: Boolean(price.firstTimeType),
        reason: price.needsOwnerPrice ? 'no_budget' : 'low_confidence',
        source: price.source || null,
        reasonFa: price.reasonFa || null,
        range: price.range || null,
        tier: price.tier || price.features?.scope || null,
      },
    });
    roomState.setCard(base.roomId, enriched);
    return enriched;
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
      priceSource: extra.price?.source ?? null,
      priceBasedOnN: extra.price?.basedOnN || 0,
      priceAsk: extra.priceAsk || null,
      priceReasonFa: extra.price?.reasonFa ?? null,
      analysisDetail: analysisDetailOf(extra.analysis),
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
    resumeAfterPrice,
    getMode() {
      return settingsStore?.get?.()?.chatAiMode || 'full_manual';
    },
  };
}

const HARD_SAFETY = new Set(['token_budget_exceeded', 'llm_fallback', 'analysis_unavailable', 'no_client_text']);

/**
 * Ask the owner «چه قیمتی بدهم؟» before auto-answering?
 * Only when the price matters in this reply (client asked price/discount, or first reply on a project),
 * the price is not the owner's own answer nor confidently learned, and either there is no budget
 * (or no similar past price) or analysis confidence is low.
 */
export function shouldAskOwnerPrice({ price, pipe, safety, card, isContinuum }) {
  if (!price) return false;
  if (price.source === 'owner_answer' || price.source === 'learned') return false;
  if (safety && HARD_SAFETY.has(safety.reason)) return false;
  const neg = pipe?.negotiation || {};
  const relevant = Boolean(neg.askedPrice || neg.askedDiscount || (card?.project && !isContinuum));
  if (!relevant) return false;
  return Boolean(price.needsOwnerPrice) || safety?.reason === 'low_confidence';
}

/**
 * Safety checks that force owner approval before the gate even runs.
 * @returns {{ reason: string, reasonFa: string }|null}
 */
export function autoSafetyCheck(pipe, settings = {}) {
  if (pipe?.budgetExceeded) {
    return { reason: 'token_budget_exceeded', reasonFa: 'سقف مصرف روزانهٔ هوش مصنوعی پر شده؛ پیش‌نویس ساده برای تأیید شما' };
  }
  if (!pipe?.llmUsed || pipe.fallback) {
    return { reason: 'llm_fallback', reasonFa: 'متن با هوش مصنوعی ساخته نشد؛ پیش‌نویس ساده فقط با تأیید شما ارسال می‌شود' };
  }
  if (!pipe.analysis?.ok) {
    return { reason: 'analysis_unavailable', reasonFa: 'تحلیل درخواست کامل نشد؛ نیاز به بررسی شما' };
  }
  const min = Number.isFinite(Number(settings.autoMinConfidence)) ? Number(settings.autoMinConfidence) : 0.6;
  if (pipe.confidence == null || pipe.confidence < min) {
    return { reason: 'low_confidence', reasonFa: 'اطمینان هوش مصنوعی به این پاسخ کم است؛ نیاز به تأیید شما' };
  }
  if (pipe.discount?.needsOwner) {
    return {
      reason: pipe.discount.reason || 'discount_over_limit',
      reasonFa: 'کارفرما تخفیفی بیشتر از سقف مجاز خواسته؛ تصمیم با شما',
    };
  }
  if (!String(pipe.clientText || '').trim()) {
    return { reason: 'no_client_text', reasonFa: 'پیام تازه‌ای از کارفرما پیدا نشد' };
  }
  return null;
}

function analysisDetailOf(analysis) {
  if (!analysis) return null;
  const d = analysis.data || analysis;
  return {
    summary: analysis.summary || d.summary || null,
    requirements: Array.isArray(d.requirements) ? d.requirements.slice(0, 12).map(String) : [],
    complexity: d.complexity || null,
    estimatedDays: Number(d.estimated_days) || null,
    confidence: Number.isFinite(Number(analysis.confidence ?? d.confidence)) ? Number(analysis.confidence ?? d.confidence) : null,
  };
}

function formatTomanFa(n) {
  try {
    return `${Number(n).toLocaleString('fa-IR')} تومان`;
  } catch {
    return `${n} تومان`;
  }
}

function hashShort(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 12);
}

export default createChatContinuum;
