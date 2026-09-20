/**
 * Layer-1 deterministic pricing rules (no LLM override of policy).
 * Stage-based ranges — not Karlancer HTTP "stage APIs".
 */
export const PRICING_RULES_VERSION = '1.0.0';

/**
 * @param {{ complexity?: 'low'|'medium'|'high', pages?: number, integrations?: number }} features
 */
export function recommendPrice(features = {}) {
  const complexity = features.complexity || 'medium';
  const pages = Number(features.pages) || 5;
  const integrations = Number(features.integrations) || 0;

  const base = { low: 8_000_000, medium: 25_000_000, high: 60_000_000 }[complexity];
  const pageFactor = Math.max(0, pages - 3) * 1_500_000;
  const integFactor = integrations * 4_000_000;
  const mid = base + pageFactor + integFactor;

  const economy = Math.round(mid * 0.7);
  const standard = mid;
  const premium = Math.round(mid * 1.4);

  let confidence = 0.55;
  if (features.complexity && features.pages) confidence = 0.7;
  if (!features.complexity) confidence = 0.35;

  return {
    rulesVersion: PRICING_RULES_VERSION,
    currency: 'IRR',
    assumptions: [
      'MVP-first; later phases priced separately',
      'No App Store / native iOS unless explicitly in scope',
      'Human approval required before sending to employer',
    ],
    options: {
      economy: { amount: economy, label: 'اقتصادی / MVP باریک' },
      standard: { amount: standard, label: 'استاندارد' },
      premium: { amount: premium, label: 'پیشرفته' },
    },
    confidence,
    evidence: { features, formula: 'base[complexity] + (pages-3)*1.5M + integrations*4M' },
    requiresApproval: true,
  };
}
