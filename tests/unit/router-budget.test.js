import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent } from '../../src/intelligence/router.js';
import { TokenBudgetManager } from '../../src/intelligence/token-budget.js';

test('routeIntent maps scan', () => {
  assert.equal(routeIntent('اسکن دعوت‌ها').intent, 'list_rooms');
});

test('TokenBudgetManager answers health directly', () => {
  const b = new TokenBudgetManager({ dailyTokenLimit: 1000, getUsage: () => ({ tokens: 0 }) });
  assert.equal(b.decide({ intent: 'health' }), 'answer_directly');
});

test('TokenBudgetManager budget exceeded', () => {
  const b = new TokenBudgetManager({ dailyTokenLimit: 10, getUsage: () => ({ tokens: 10 }) });
  assert.equal(b.decide({ intent: 'analyze_project' }), 'budget_exceeded');
});

test('cache hit', () => {
  const b = new TokenBudgetManager();
  b.putCache('k1', { ok: true }, 60_000);
  assert.equal(b.decide({ intent: 'analyze_project', cacheKey: 'k1' }), 'use_cache');
});

test('stale cache must NOT return use_cache', () => {
  const b = new TokenBudgetManager();
  b.putCache('expired', { ok: true }, 1);
  // force expiry
  const hit = b.cache.get('expired');
  hit.exp = Date.now() - 1000;
  assert.equal(b.decide({ intent: 'analyze_project', cacheKey: 'expired' }), 'call_large_model');
  assert.equal(b.getCache('expired'), null);
});
