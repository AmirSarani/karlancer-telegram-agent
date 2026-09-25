/**
 * LLM analysis + draft helpers for chat rooms.
 * Never sends chat messages; returns updated draft text only.
 *
 * The client's real messages are ALWAYS the employer_message; owner / internal
 * notes are passed separately as internal_note (added, never a replacement).
 */
import { mergeNoteIntoDraft } from './room-state.js';
import { buildDraftReply } from './draft-api.js';
import { cleanHumanReply } from './reply-clean.js';
import { buildConversationHistory, latestClientTurn } from './conversation.js';

/**
 * @param {object} roomContext
 * @returns {{ history: ReturnType<typeof buildConversationHistory>, clientTurn: string[] }}
 */
export function conversationFromContext(roomContext = {}) {
  const history = Array.isArray(roomContext.history)
    ? roomContext.history
    : buildConversationHistory(roomContext.messages || []);
  const clientTurn = latestClientTurn(history);
  return { history, clientTurn };
}

/**
 * Adapt draft for ONE room using the real conversation + optional internal note + LLM.
 * Falls back to deterministic merge when LLM disabled/fails (flagged: llmUsed=false, fallback=true).
 *
 * @param {object} opts
 * @param {object} opts.roomContext  fields for buildDraftReply (+ messages/history)
 * @param {string} [opts.currentDraft]
 * @param {string} [opts.ownerNote]  owner's own note (merged into fallback draft too)
 * @param {string} [opts.internalNote]  system hints (price/limits) — LLM only, never merged into text
 * @param {object|null} [opts.llm]
 * @param {'note'|'analyze'} [opts.mode='note']
 * @param {object|null} [opts.analysis]  analyzeRoomWithLlm result
 * @param {object|null} [opts.pricing]
 * @param {object|null} [opts.negotiation]
 */
export async function adaptDraftWithNote(opts = {}) {
  const {
    roomContext = {},
    currentDraft = '',
    ownerNote = '',
    internalNote = '',
    llm = null,
    mode = 'note',
    analysis = null,
    pricing = null,
    negotiation = null,
  } = opts;

  const baseDraft =
    String(currentDraft || '').trim() ||
    buildDraftReply({ ...roomContext, ownerNote: '' }).text;

  const note = String(ownerNote || '').trim();

  // Deterministic baseline (owner-visible only; never auto-sent)
  const merged = mergeNoteIntoDraft({ text: baseDraft, source: 'template' }, note);

  if (!note && mode !== 'analyze') {
    return {
      ok: true,
      text: cleanHumanReply(baseDraft),
      source: 'template',
      llmUsed: false,
      fallback: true,
    };
  }

  if (!llm || typeof llm.draftChatReply !== 'function') {
    return {
      ok: true,
      text: cleanHumanReply(merged.text),
      source: merged.source,
      llmUsed: false,
      fallback: true,
      reason: 'llm_disabled',
    };
  }

  const { history, clientTurn } = conversationFromContext(roomContext);
  const employerMessage = clientTurn.join('\n') || '';

  try {
    const out = await llm.draftChatReply({
      roomContext: {
        guestName: roomContext.guestName,
        projectTitle: roomContext.project?.title || roomContext.projectTitle,
        projectDescription: roomContext.project?.description
          ? String(roomContext.project.description).slice(0, 800)
          : undefined,
        budget: roomContext.project
          ? {
              min: roomContext.project.minBudget ?? roomContext.project.min_budget,
              max: roomContext.project.maxBudget ?? roomContext.project.max_budget,
              currency: 'تومان',
            }
          : null,
        mode,
      },
      employerMessage: employerMessage || baseDraft,
      history,
      internalNote: [note, String(internalNote || '').trim()].filter(Boolean).join('\n'),
      analysis: analysis?.data || null,
      pricing,
      negotiation,
    });

    const reply =
      out?.data?.reply_text ||
      out?.data?.proposal_text ||
      (typeof out?.data === 'string' ? out.data : null);

    const isFallback = out?.fallback === true || out?.source === 'deterministic_fallback';
    if (out?.ok && reply && String(reply).trim() && !isFallback) {
      return {
        ok: true,
        text: cleanHumanReply(String(reply).trim()).slice(0, 4000),
        source: 'llm+note',
        llmUsed: true,
        fallback: false,
        confidence: out.data?.confidence,
      };
    }
  } catch {
    /* fall through to deterministic */
  }

  return {
    ok: true,
    text: cleanHumanReply(merged.text),
    source: merged.source,
    llmUsed: false,
    fallback: true,
    reason: 'llm_fallback',
  };
}

/**
 * Analysis of project OR direct-chat request (from client's messages).
 * `ok:false` when LLM unavailable or it fell back to heuristics.
 */
export async function analyzeRoomWithLlm({ roomContext = {}, llm = null } = {}) {
  if (!llm || typeof llm.analyzeProject !== 'function') {
    return {
      ok: false,
      reason: 'llm_disabled',
      summary: 'تحلیل AI در دسترس نیست (کلید یا مدل تنظیم نشده).',
    };
  }
  const project = roomContext.project || {};
  const { history, clientTurn } = conversationFromContext(roomContext);
  const clientMessages = history.filter((h) => h.role !== 'me').map((h) => h.text).slice(-6);
  try {
    const out = await llm.analyzeProject({
      title: project.title || (clientTurn[0] ? String(clientTurn[0]).slice(0, 80) : undefined),
      description: project.description || clientMessages.join('\n'),
      budget: {
        min: project.minBudget ?? project.min_budget,
        max: project.maxBudget ?? project.max_budget,
      },
      clientMessages,
      conversation: history,
    });
    if (out?.ok) {
      const isFallback = out.fallback === true || out.source === 'deterministic_fallback';
      return {
        ok: !isFallback,
        fallback: isFallback,
        summary: out.data?.summary || 'تحلیل انجام شد.',
        data: out.data,
        confidence: Number(out.data?.confidence) || 0,
        source: out.source,
      };
    }
  } catch (e) {
    return { ok: false, reason: e?.message || 'llm_error', summary: 'خطا در تحلیل AI.' };
  }
  return { ok: false, reason: 'llm_failed', summary: 'تحلیل AI ناموفق بود.' };
}

export default { adaptDraftWithNote, analyzeRoomWithLlm, conversationFromContext };
