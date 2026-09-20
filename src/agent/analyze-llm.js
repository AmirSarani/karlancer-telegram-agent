/**
 * Optional LLM polish — ONLY when owner requests analysis or adds a note.
 * Never sends chat messages; returns updated draft text only.
 */
import { mergeNoteIntoDraft } from './room-state.js';
import { buildDraftReply } from './draft-api.js';

/**
 * Adapt draft for ONE room using owner note + optional LLM.
 * Falls back to deterministic merge when LLM disabled/fails.
 *
 * @param {object} opts
 * @param {object} opts.roomContext  fields for buildDraftReply
 * @param {string} [opts.currentDraft]
 * @param {string} opts.ownerNote
 * @param {object|null} [opts.llm]  createLlmProvider instance
 * @param {'note'|'analyze'} [opts.mode='note']
 */
export async function adaptDraftWithNote(opts = {}) {
  const {
    roomContext = {},
    currentDraft = '',
    ownerNote = '',
    llm = null,
    mode = 'note',
  } = opts;

  const baseDraft =
    String(currentDraft || '').trim() ||
    buildDraftReply({ ...roomContext, ownerNote: '' }).text;

  const note = String(ownerNote || '').trim();

  // Always have a deterministic baseline
  const merged = mergeNoteIntoDraft({ text: baseDraft, source: 'template' }, note);

  if (!note && mode !== 'analyze') {
    return {
      ok: true,
      text: baseDraft,
      source: 'template',
      llmUsed: false,
    };
  }

  if (!llm || typeof llm.draftChatReply !== 'function') {
    return {
      ok: true,
      text: merged.text,
      source: merged.source,
      llmUsed: false,
      reason: 'llm_disabled',
    };
  }

  try {
    const out = await llm.draftChatReply({
      roomContext: {
        guestName: roomContext.guestName,
        projectTitle: roomContext.project?.title || roomContext.projectTitle,
        budget: roomContext.project
          ? {
              min: roomContext.project.minBudget ?? roomContext.project.min_budget,
              max: roomContext.project.maxBudget ?? roomContext.project.max_budget,
            }
          : null,
        ownerNote: note,
        mode,
      },
      employerMessage:
        note ||
        (roomContext.messages || [])
          .filter((m) => m && m.isOwn !== true)
          .map((m) => m.text)
          .slice(-3)
          .join('\n') ||
        baseDraft,
    });

    const reply =
      out?.data?.reply_text ||
      out?.data?.proposal_text ||
      (typeof out?.data === 'string' ? out.data : null);

    if (out?.ok && reply && String(reply).trim()) {
      return {
        ok: true,
        text: String(reply).trim().slice(0, 4000),
        source: 'llm+note',
        llmUsed: true,
        confidence: out.data?.confidence,
      };
    }
  } catch {
    /* fall through to deterministic */
  }

  return {
    ok: true,
    text: merged.text,
    source: merged.source,
    llmUsed: false,
    reason: 'llm_fallback',
  };
}

/**
 * Pure analysis summary without changing draft (optional helper).
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
  try {
    const out = await llm.analyzeProject({
      title: project.title,
      description: project.description,
      budget: {
        min: project.minBudget ?? project.min_budget,
        max: project.maxBudget ?? project.max_budget,
      },
    });
    if (out?.ok) {
      return {
        ok: true,
        summary: out.data?.summary || 'تحلیل انجام شد.',
        data: out.data,
        source: out.source,
      };
    }
  } catch (e) {
    return { ok: false, reason: e?.message || 'llm_error', summary: 'خطا در تحلیل AI.' };
  }
  return { ok: false, reason: 'llm_failed', summary: 'تحلیل AI ناموفق بود.' };
}

export default { adaptDraftWithNote, analyzeRoomWithLlm };
