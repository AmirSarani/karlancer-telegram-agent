import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendPrice, PRICING_RULES_VERSION } from '../../src/intelligence/pricing.js';

test('recommendPrice returns options with confidence', () => {
  const r = recommendPrice({ complexity: 'medium', pages: 5, integrations: 1 });
  assert.equal(r.rulesVersion, PRICING_RULES_VERSION);
  assert.ok(r.options.standard.amount > r.options.economy.amount);
  assert.ok(r.options.premium.amount > r.options.standard.amount);
  assert.equal(r.requiresApproval, true);
  assert.ok(r.confidence >= 0.5);
});

test('low confidence without features', () => {
  const r = recommendPrice({});
  assert.ok(r.confidence < 0.5);
});
