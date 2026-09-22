/**
 * Suggest a chat reply price from project budget / scoring — never forced into message
 * unless caller (full_auto or owner) includes it.
 */
import { recommendPrice } from '../intelligence/pricing.js';

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
      const amount = rec?.options?.standard?.amount ?? rec?.range?.min ?? null;
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

export default suggestChatPrice;
