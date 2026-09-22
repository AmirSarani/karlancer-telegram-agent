/**
 * Intelligence layers 1–5 — honest, no fake ML.
 */
import { recommendPrice, PRICING_RULES_VERSION } from './pricing.js';
import { memorySearch, memoryAppend } from '../memory/store.js';
import crypto from 'node:crypto';

export function extractFeatures(project = {}, extras = {}) {
  return {
    projectType: extras.projectType || inferType(project),
    pages: Number(extras.pages ?? project.pages) || null,
    integrations: Number(extras.integrations) || 0,
    complexity: extras.complexity || null,
    deadline: extras.deadline || project.deadline || null,
    clientBudget: project.budget ?? extras.clientBudget ?? null,
    similarHistoryCount: extras.similarHistoryCount ?? 0,
    rework: extras.rework ?? 0,
    actualDays: extras.actualDays ?? null,
    profitLoss: extras.profitLoss ?? null,
  };
}

function inferType(project) {
  const t = `${project.title || ''} ${project.description || ''}`.toLowerCase();
  if (/mobile|ios|android|flutter/.test(t)) return 'mobile';
  if (/wordpress|woocommerce/.test(t)) return 'wordpress';
  if (/shop|فروشگاه|ecommerce/.test(t)) return 'ecommerce';
  if (/ai|ml|llm/.test(t)) return 'ai';
  return 'web';
}

/**
 * Layer 4 recommendation — always requires human approval.
 * Returns insufficient_data when memory evidence is too thin.
 */
export function getInsight(db, { project, features: featIn, tenantId } = {}) {
  if (!tenantId) throw new Error('tenantId_required');
  const features = extractFeatures(project || {}, featIn || {});
  const history = memorySearch(db, { tenantId, kind: 'pricing_decision', limit: 50 });
  const feedback = memorySearch(db, { tenantId, kind: 'intelligence_feedback', limit: 50 });

  const minSamples = 3;
  const insufficient = history.length + feedback.length < minSamples;

  if (!features.complexity && features.pages == null) {
    return {
      status: 'insufficient_data',
      reason: 'missing_complexity_and_pages',
      features,
      requiresApproval: true,
      rulesVersion: PRICING_RULES_VERSION,
    };
  }

  const complexity =
    features.complexity ||
    (features.pages > 12 ? 'high' : features.pages > 6 ? 'medium' : 'low');

  const pricing = recommendPrice({
    complexity,
    pages: features.pages || 5,
    integrations: features.integrations,
  });

  const confidence = insufficient
    ? Math.min(pricing.confidence, 0.4)
    : Math.min(0.85, pricing.confidence + 0.1);

  return {
    status: insufficient ? 'insufficient_data' : 'ok',
    layer: 'rules+memory',
    rulesVersion: PRICING_RULES_VERSION,
    features,
    options: pricing.options,
    range: {
      min: pricing.options.economy.amount,
      max: pricing.options.premium.amount,
      currency: pricing.currency,
    },
    assumptions: pricing.assumptions,
    evidence: [
      ...pricing.evidence.features ? [`features:${JSON.stringify(pricing.evidence.features)}`] : [],
      `history_samples:${history.length}`,
      `feedback_samples:${feedback.length}`,
      ...(insufficient ? ['insufficient_data:using_rules_only'] : []),
    ],
    confidence,
    risk: complexity === 'high' ? 'elevated' : 'normal',
    reason: insufficient
      ? 'Rules-only recommendation; not enough outcome data for calibrated confidence'
      : 'Rules + limited memory samples',
    requiresApproval: true,
    mlInProduction: false,
  };
}

export function recordFeedback(db, {
  recommendationId,
  features,
  output,
  humanDecision,
  actualOutcome,
  feedback,
  rulesVersion = PRICING_RULES_VERSION,
  tenantId = 'default',
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO intelligence_feedback (
      id, tenant_id, recommendation_id, rules_version, features_json, output_json,
      human_decision, actual_outcome, feedback, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tenantId,
    recommendationId || null,
    rulesVersion,
    JSON.stringify(features || {}),
    JSON.stringify(output || {}),
    humanDecision || null,
    actualOutcome || null,
    feedback || null,
    now
  );
  memoryAppend(db, {
    tenantId,
    kind: 'intelligence_feedback',
    refId: recommendationId || id,
    content: `${humanDecision || ''} ${feedback || ''}`.trim(),
    meta: { actualOutcome },
  });
  return { id, createdAt: now };
}

export default { getInsight, extractFeatures, recordFeedback };
