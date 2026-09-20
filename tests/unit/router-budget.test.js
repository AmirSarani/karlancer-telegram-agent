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
  b.putCache('k1', { ok: true });
  assert.equal(b.decide({ intent: 'analyze_project', cacheKey: 'k1' }), 'use_cache');
});
