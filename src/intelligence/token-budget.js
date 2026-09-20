/**
 * TokenBudgetManager — decide whether to call LLM or answer deterministically.
 */
export class TokenBudgetManager {
  /**
   * @param {{ dailyTokenLimit?: number, perRequestLimit?: number, getUsage?: Function }} [opts]
   */
  constructor(opts = {}) {
    this.dailyTokenLimit = opts.dailyTokenLimit ?? 200_000;
    this.perRequestLimit = opts.perRequestLimit ?? 8_000;
    this.getUsage = opts.getUsage || (() => ({ tokens: 0 }));
    this.cache = new Map();
  }

  /**
   * @param {{ intent: string, ambiguity?: number, cacheKey?: string, estimatedTokens?: number }} req
   * @returns {'answer_directly'|'use_cache'|'retrieve_summary'|'call_small_model'|'call_large_model'|'request_clarification'|'budget_exceeded'}
   */
  decide(req) {
    const { intent, ambiguity = 0, cacheKey, estimatedTokens = 500 } = req;
    if (cacheKey && this.cache.has(cacheKey)) return 'use_cache';

    const usage = this.getUsage();
    if (usage.tokens >= this.dailyTokenLimit) return 'budget_exceeded';
    if (estimatedTokens > this.perRequestLimit) return 'retrieve_summary';

    const deterministic = new Set([
      'health',
      'job_status',
      'list_rooms',
      'get_project',
      'check_bid',
      'memory_search',
      'approve',
      'reject',
      'pause',
      'resume',
    ]);
    if (deterministic.has(intent)) return 'answer_directly';

    if (ambiguity >= 0.7) return 'request_clarification';
    if (intent === 'analyze_project' || intent === 'write_proposal') return 'call_large_model';
    if (intent === 'classify' || intent === 'summarize') return 'call_small_model';
    if (intent === 'pricing') return 'call_small_model';
    return 'answer_directly';
  }

  putCache(key, value, ttlMs = 300_000) {
    this.cache.set(key, { value, exp: Date.now() + ttlMs });
  }

  getCache(key) {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) {
      this.cache.delete(key);
      return null;
    }
    return hit.value;
  }
}

export default TokenBudgetManager;
