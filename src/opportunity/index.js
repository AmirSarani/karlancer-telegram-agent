/** Opportunity intelligence public surface */
export {
  createOpportunityStore,
  ensureOpportunitySchema,
  OPP_STATES,
  OPP_ACTIONS,
  DECISIONS,
  defaultScoringProfile,
} from './store.js';
export { toProjectOpportunity } from './normalize.js';
export {
  matchRules,
  evaluateConditions,
  evaluateOne,
  ruleActionToDecision,
} from './rules-engine.js';
export { scoreOpportunity, isScoringConfigured } from './scoring.js';
export { decideOpportunity } from './decision-engine.js';
export {
  createOpportunityScanner,
  formatOpportunityNotify,
} from './scanner.js';
