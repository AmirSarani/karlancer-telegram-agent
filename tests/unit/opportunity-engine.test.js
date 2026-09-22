import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { toProjectOpportunity } from '../../src/opportunity/normalize.js';
import {
  createOpportunityStore,
  ensureOpportunitySchema,
} from '../../src/opportunity/store.js';
import { matchRules, evaluateOne, ruleActionToDecision } from '../../src/opportunity/rules-engine.js';
import { scoreOpportunity, isScoringConfigured } from '../../src/opportunity/scoring.js';
import { decideOpportunity } from '../../src/opportunity/decision-engine.js';
import { createOpportunityScanner } from '../../src/opportunity/scanner.js';
import { createAgentSettingsStore } from '../../src/telegram/agent-settings.js';
import { createPermissionGate } from '../../src/telegram/permission-gate.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opp-test-'));
  const db = openDb(path.join(dir, 't.sqlite'));
  ensureOpportunitySchema(db);
  return db;
}

function sampleOpp(over = {}) {
  return toProjectOpportunity(
    {
      id: 1001,
      title: 'طراحی سایت وردپرسی فروشگاهی',
      description: 'نیاز به وردپرس و ووکامرس',
      min_budget: 8_000_000,
      max_budget: 18_000_000,
      category_id: 6,
      skills: [{ name: 'وردپرس' }, { name: 'ووکامرس' }],
      rate: 4.6,
      ladder_at: new Date().toISOString(),
      ...over,
    },
    { source: 'search' }
  );
}

test('normalize maps real adapter/HAR fields', () => {
  const o = sampleOpp();
  assert.equal(o.id, '1001');
  assert.ok(o.title.includes('وردپرس'));
  assert.equal(o.budgetMin, 8_000_000);
  assert.equal(o.budgetMax, 18_000_000);
  assert.equal(o.category, '6');
  assert.deepEqual(o.skills, ['وردپرس', 'ووکامرس']);
  assert.equal(o.client.rate, 4.6);
  assert.equal(o.source, 'search');
  assert.ok(o.ageHours != null);
});

test('scoring is explainable and configured when profile set', () => {
  const profile = {
    preferredSkills: ['وردپرس'],
    preferredCategories: ['6'],
    budgetMin: 5e6,
    budgetMax: 30e6,
  };
  assert.equal(isScoringConfigured({}), false);
  assert.equal(isScoringConfigured(profile), true);
  const { score, reasons, breakdown } = scoreOpportunity(sampleOpp(), profile);
  assert.ok(score >= 80);
  assert.ok(reasons.length >= 3);
  assert.ok(reasons.every((r) => /[+\-]|۰|امتیاز|مهارت|بودجه|دسته|تازه|کارفرما/.test(r)));
  assert.equal(typeof breakdown.skills, 'number');
});

test('rule engine matches data-driven conditions', () => {
  const db = tmpDb();
  const store = createOpportunityStore(db);
  store.createRule({
    name: 'wp',
    action: 'CREATE_BID_DRAFT',
    priority: 10,
    conditions: [
      { field: 'skills', op: 'has_any', value: ['وردپرس'] },
      { field: 'budgetMin', op: 'gte', value: 5_000_000 },
    ],
  });
  const rules = store.listRules({ enabledOnly: true });
  const { matched, primary } = matchRules(sampleOpp(), rules);
  assert.equal(matched.length, 1);
  assert.equal(primary.action, 'CREATE_BID_DRAFT');
  assert.equal(ruleActionToDecision('CREATE_BID_DRAFT'), 'CREATE_DRAFT');
  assert.equal(evaluateOne(sampleOpp(), { field: 'title', op: 'contains', value: 'فروشگاهی' }), true);
});

test('decision engine respects modes, limits, emergency, duplicates', () => {
  const db = tmpDb();
  const settingsStore = createAgentSettingsStore(db);
  const gate = createPermissionGate(db);
  const profile = {
    preferredSkills: ['وردپرس'],
    preferredCategories: ['6'],
    budgetMin: 1e6,
    budgetMax: 50e6,
  };
  const scored = scoreOpportunity(sampleOpp(), profile);
  const matched = [
    {
      ruleId: 'r1',
      name: 'wp',
      action: 'AUTO_EXECUTE',
      priority: 1,
      meta: {},
    },
  ];

  // Manual → never silent auto
  settingsStore.setMode('manual');
  let d = decideOpportunity({
    opportunity: sampleOpp(),
    score: scored.score,
    reasons: scored.reasons,
    matchedRules: matched,
    settings: settingsStore.get(),
    gate,
    todayCounts: { messages: 0, bids: 0 },
  });
  assert.notEqual(d.decision, 'AUTO_EXECUTE');
  assert.ok(['CREATE_DRAFT', 'NOTIFY', 'REQUEST_APPROVAL'].includes(d.decision));

  // Assisted → draft/notify, not auto bid
  settingsStore.setMode('assisted');
  d = decideOpportunity({
    opportunity: sampleOpp(),
    score: scored.score,
    reasons: scored.reasons,
    matchedRules: matched,
    settings: settingsStore.get(),
    gate,
    todayCounts: { messages: 0, bids: 0 },
  });
  assert.notEqual(d.decision, 'AUTO_EXECUTE');

  // Auto without toggle → approval
  settingsStore.setMode('auto');
  settingsStore.setToggle('autoSubmitBids', false);
  d = decideOpportunity({
    opportunity: sampleOpp(),
    score: scored.score,
    reasons: scored.reasons,
    matchedRules: matched,
    settings: settingsStore.get(),
    gate,
    todayCounts: { messages: 0, bids: 0 },
  });
  assert.ok(['REQUEST_APPROVAL', 'CREATE_DRAFT', 'NOTIFY'].includes(d.decision));

  // Emergency stop
  settingsStore.emergencyStop();
  d = decideOpportunity({
    opportunity: sampleOpp(),
    score: scored.score,
    reasons: scored.reasons,
    matchedRules: matched,
    settings: settingsStore.get(),
    gate,
    todayCounts: { messages: 0, bids: 0 },
  });
  assert.ok(['IGNORE', 'NOTIFY'].includes(d.decision));

  // Duplicate / already acted
  settingsStore.clearEmergency();
  settingsStore.setMode('auto');
  d = decideOpportunity({
    opportunity: sampleOpp(),
    score: scored.score,
    reasons: scored.reasons,
    matchedRules: matched,
    settings: settingsStore.get(),
    gate,
    todayCounts: { messages: 0, bids: 0 },
    alreadyActed: true,
  });
  assert.equal(d.decision, 'IGNORE');
});

test('scanner end-to-end with mock API sets scoringAvailable', async () => {
  const db = tmpDb();
  const api = {
    client: { hasAuth: false },
    projects: {
      async search() {
        return {
          projects: [
            {
              id: 55,
              title: 'وردپرس خبری',
              description: 'سایت خبری',
              min_budget: 10e6,
              max_budget: 20e6,
              category_id: 6,
              skills: [{ name: 'وردپرس' }],
              rate: 5,
              ladder_at: new Date().toISOString(),
            },
          ],
        };
      },
    },
    rooms: { async list() { return { rooms: [] }; } },
    messages: { async list() { return { messages: [] }; } },
  };
  const notified = [];
  const scanner = createOpportunityScanner({
    db,
    api,
    notify: async (text) => notified.push(text),
  });
  scanner.store.setScoringProfile({
    preferredSkills: ['وردپرس'],
    preferredCategories: ['6'],
    budgetMin: 5e6,
    budgetMax: 40e6,
  });
  scanner.store.createRule({
    name: 'wp-notify',
    action: 'NOTIFY',
    priority: 5,
    conditions: [{ field: 'skills', op: 'has_any', value: ['وردپرس'] }],
  });
  const out = await scanner.scan({ manual: true, pages: 1, includeInvites: false });
  assert.equal(out.ok, true);
  assert.equal(out.scanned, 1);
  assert.ok(out.newCount >= 1);
  assert.ok(out.matched >= 1);
  assert.ok(notified.length >= 1);
  assert.equal(scanner.syncScoringAvailable(), true);
  const settings = createAgentSettingsStore(db).get();
  assert.equal(settings.rules.bidAuto.scoringAvailable, true);
  assert.equal(settings.rules.messageAuto.scoringAvailable, true);
});

test('rule CRUD enable/disable persists', () => {
  const db = tmpDb();
  const store = createOpportunityStore(db);
  const rule = store.createRule({
    name: 'tmp',
    action: 'IGNORE',
    conditions: [{ field: 'title', op: 'contains', value: 'x' }],
  });
  assert.equal(rule.enabled, true);
  store.setRuleEnabled(rule.ruleId, false);
  assert.equal(store.getRule(rule.ruleId).enabled, false);
  store.setRuleEnabled(rule.ruleId, true);
  assert.equal(store.getRule(rule.ruleId).enabled, true);
  assert.equal(store.deleteRule(rule.ruleId), true);
});
