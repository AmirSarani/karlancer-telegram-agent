/**
 * Suggest a chat reply price from project budget / scoring — never forced into message
 * unless caller (full_auto or owner) includes it.
 */
import { recommendPrice } from '../intelligence/pricing.js';
import { extractPriceFeatures, learnedPriceFor, getRoomPriceAnswer, roundToman } from './price-memory.js';

/**
 * @param {object} [project]
 * @param {object} [scoringProfile]
 * @returns {{ amount: number|null, labelFa: string|null, source: string, includeInDraft: boolean }}
 */
export function suggestChatPrice(project = {}, scoringProfile = {}) {
  const minB = num(project.minBudget ?? project.min_budget ?? project.budgetMin);
  const maxB = num(project.maxBudget ?? project.max_budget ?? project.budgetMax);
  const mid =
    minB != null && maxB != null ? (minB + maxB) / 2 : maxB ?? minB ?? null;

  if (mid == null || mid <= 0) {
    try {
      const rec = recommendPrice({
        complexity: scoringProfile.complexity || 'medium',
        pages: scoringProfile.pages,
        integrations: scoringProfile.integrations,
      });
      const raw = rec?.options?.standard?.amount ?? rec?.range?.min ?? null;
      const amount = raw != null ? roundToman(raw) : null;
      return {
        amount: amount != null ? Math.round(Number(amount)) : null,
        labelFa: amount != null ? formatToman(amount) : null,
        source: 'pricing_rules',
        includeInDraft: false,
      };
    } catch {
      return { amount: null, labelFa: null, source: 'none', includeInDraft: false };
    }
  }

  // Bias slightly under mid when profile asks for competitive; else near mid.
  const bias = Number(scoringProfile.priceBias);
  const factor = Number.isFinite(bias) ? Math.min(1.15, Math.max(0.7, bias)) : 0.92;
  let amount = Math.round(mid * factor);
  if (minB != null) amount = Math.max(amount, Math.round(minB * 0.85));
  if (maxB != null) amount = Math.min(amount, Math.round(maxB));

  return {
    amount,
    labelFa: formatToman(amount),
    source: 'project_budget',
    includeInDraft: false,
    budgetMin: minB,
    budgetMax: maxB,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatToman(n) {
  try {
    return `${Number(n).toLocaleString('fa-IR')} تومان`;
  } catch {
    return `${n} تومان`;
  }
}



/**
 * Phase C price decision for a chat (Toman).
 * Order: owner's answer for this room → confident learned median (≥5 similar, low spread)
 * → project budget (nudged toward learned median when available) → learned median → pricing rules.
 * `needsOwnerPrice` = no owner answer, not confidently learned, and no project budget.
 *
 * @param {{ db?: any, card?: object, clientText?: string, analysis?: object, scoringProfile?: object }} input
 */
export function decideChatPrice({ db = null, card = {}, clientText = '', analysis = null, scoringProfile = {} } = {}) {
  const roomId = card?.roomId != null ? String(card.roomId) : null;
  const project = card?.project || {};
  const features = extractPriceFeatures({ project: card?.project || null, analysis, clientText, messages: card?.messages });
  const learned = db ? learnedPriceFor(db, features) : { count: 0, confident: false, amount: null };
  const extra = { features, basedOnN: 0, learnedCount: learned.count, needsOwnerPrice: false, firstTimeType: learned.count === 0 };

  const answer = db && roomId ? getRoomPriceAnswer(db, roomId) : null;
  if (answer?.amount) {
    return { amount: answer.amount, labelFa: formatToman(answer.amount), source: 'owner_answer', includeInDraft: false, ...extra };
  }
  if (learned.confident && learned.amount) {
    return {
      amount: learned.amount,
      labelFa: formatToman(learned.amount),
      source: 'learned',
      includeInDraft: false,
      ...extra,
      basedOnN: learned.count,
    };
  }

  const base = suggestChatPrice(project, scoringProfile || {});
  if (base.source === 'project_budget' && base.amount) {
    if (learned.count >= 3 && learned.amount) {
      let amount = learned.amount;
      if (base.budgetMin != null) amount = Math.max(amount, Math.round(base.budgetMin * 0.85));
      if (base.budgetMax != null) amount = Math.min(amount, Math.round(base.budgetMax));
      return { ...base, amount, labelFa: formatToman(amount), source: 'budget_learned', ...extra, basedOnN: learned.count };
    }
    return { ...base, ...extra };
  }

  if (learned.count > 0 && learned.amount) {
    return {
      amount: learned.amount,
      labelFa: formatToman(learned.amount),
      source: 'learned_uncertain',
      includeInDraft: false,
      ...extra,
      basedOnN: learned.count,
      needsOwnerPrice: true,
    };
  }
  return { ...base, ...extra, needsOwnerPrice: true };
}

export default suggestChatPrice;
