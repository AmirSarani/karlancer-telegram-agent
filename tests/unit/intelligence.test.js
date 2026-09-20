import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { getInsight, recordFeedback } from '../../src/intelligence/engine.js';
import { recommendPrice } from '../../src/intelligence/pricing.js';

test('pricing recommendation includes approval flag', () => {
  const r = recommendPrice({ complexity: 'medium', pages: 8, integrations: 1 });
  assert.equal(r.requiresApproval, true);
  assert.ok(r.options.economy.amount < r.options.premium.amount);
});

test('intelligence returns insufficient_data without samples', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'i.sqlite'));
  const insight = getInsight(db, { features: { complexity: 'low', pages: 3 } });
  assert.equal(insight.status, 'insufficient_data');
  assert.equal(insight.requiresApproval, true);
  assert.equal(insight.mlInProduction, false);
  assert.ok(insight.confidence <= 0.4);
});

test('feedback recording', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'i2.sqlite'));
  const row = recordFeedback(db, {
    humanDecision: 'approved_standard',
    actualOutcome: 'won',
    feedback: 'good',
    features: { pages: 5 },
    output: { amount: 1 },
  });
  assert.ok(row.id);
});
