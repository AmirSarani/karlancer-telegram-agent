/**
 * P0: intelligence / pricing / feedback memory is tenant-scoped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { getInsight, recordFeedback } from '../../src/intelligence/engine.js';
import { memoryAppend, memorySearch } from '../../src/memory/store.js';

function tmpDb() {
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-intl-')), 'i.sqlite'));
}

test('recordFeedback passes tenantId into memoryAppend — tenant-b invisible to default/a', () => {
  const db = tmpDb();
  recordFeedback(db, {
    tenantId: 'tenant-b',
    humanDecision: 'accepted',
    feedback: 'secret-from-b',
    features: { pages: 4 },
    output: { amount: 9 },
  });
  memoryAppend(db, {
    tenantId: 'tenant-b',
    kind: 'pricing_decision',
    content: 'amount=999 from-b',
    meta: { amount: 999 },
  });

  assert.equal(memorySearch(db, { tenantId: 'default', kind: 'intelligence_feedback', limit: 50 }).length, 0);
  assert.equal(memorySearch(db, { tenantId: 'tenant-a', kind: 'intelligence_feedback', limit: 50 }).length, 0);
  assert.ok(memorySearch(db, { tenantId: 'tenant-b', kind: 'intelligence_feedback', limit: 50 }).length >= 1);
  assert.equal(memorySearch(db, { tenantId: 'default', kind: 'pricing_decision', limit: 50 }).length, 0);
});

test('getInsight requires tenantId and does not leak tenant-b samples', () => {
  const db = tmpDb();
  assert.throws(() => getInsight(db, { features: { complexity: 'low', pages: 3 } }), /tenantId_required/);

  for (let i = 0; i < 5; i++) {
    memoryAppend(db, { tenantId: 'tenant-b', kind: 'pricing_decision', content: `amount=${i}`, meta: {} });
    memoryAppend(db, { tenantId: 'tenant-b', kind: 'intelligence_feedback', content: `fb-${i}`, meta: {} });
  }

  const insightA = getInsight(db, {
    tenantId: 'tenant-a',
    features: { complexity: 'low', pages: 3 },
  });
  assert.equal(insightA.status, 'insufficient_data');
  assert.equal(insightA.evidence.find((e) => e.startsWith('history_samples:')), 'history_samples:0');
  assert.equal(insightA.evidence.find((e) => e.startsWith('feedback_samples:')), 'feedback_samples:0');

  const insightB = getInsight(db, {
    tenantId: 'tenant-b',
    features: { complexity: 'low', pages: 3 },
  });
  assert.equal(insightB.status, 'ok');
});
