
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { ensureOpportunitySchema, createOpportunityStore } from '../../src/opportunity/store.js';
import { scoreOpportunity, isScoringConfigured } from '../../src/opportunity/scoring.js';
import { buildSmartBid } from '../../src/opportunity/smart-bid.js';
import { createFeedbackStore } from '../../src/opportunity/feedback.js';
import { toProjectOpportunity } from '../../src/opportunity/normalize.js';
import { checkTokenHealth } from '../../src/security/token-health.js';
import {
  parseRuleCreateText,
  formatMorningDigest,
  formatDecisionInbox,
  parseOpportunityCallback,
} from '../../src/telegram/opportunity-ux.js';
import { mapMenuText, BTN, parseCallbackData } from '../../src/telegram/ui.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opp-road-'));
  const db = openDb(path.join(dir, 't.sqlite'));
  ensureOpportunitySchema(db);
  return { db, dir };
}

function sampleOpp() {
  return toProjectOpportunity({
    id: 2002,
    title: 'سایت فروشگاهی وردپرس',
    description: 'نیاز به وردپرس',
    min_budget: 10_000_000,
    max_budget: 20_000_000,
    category_id: 6,
    skills: [{ name: 'وردپرس' }],
    rate: 4.8,
    ladder_at: new Date().toISOString(),
  });
}

test('scoring profile configures scoringAvailable helper', () => {
  assert.equal(isScoringConfigured({}), false);
  assert.equal(
    isScoringConfigured({ preferredSkills: ['وردپرس'], budgetMin: 1e6 }),
    true
  );
});

test('client quality omitted when no real client fields', () => {
  const bare = toProjectOpportunity({
    id: 9,
    title: 'x',
    skills: [],
  });
  // wipe client
  bare.client = null;
  const { reasons, breakdown } = scoreOpportunity(bare, { preferredSkills: ['x'] });
  assert.equal(breakdown.client, 0);
  assert.ok(reasons.some((r) => /کارفرما|حذف/.test(r)));
});

test('smart bid is Persian human text with price/days', () => {
  const bid = buildSmartBid(sampleOpp(), {
    preferredSkills: ['وردپرس'],
    budgetMin: 5e6,
    budgetMax: 25e6,
  }, { score: 88 });
  assert.ok(bid.text.includes('سلام'));
  assert.ok(!/projectId|Bearer|mock/i.test(bid.text));
  assert.ok(bid.price > 0);
  assert.ok(bid.days >= 3);
  assert.ok(bid.previewFa.includes('پیشنهاد هوشمند'));
});

test('feedback learning adjusts score with explainable reason', () => {
  const { db } = tmpDb();
  const fb = createFeedbackStore(db);
  const opp = sampleOpp();
  fb.record('ignore', opp);
  const scored = scoreOpportunity(opp, { preferredSkills: ['وردپرس'] });
  const biased = fb.applyBias(scored, opp, []);
  assert.ok(biased.score <= scored.score);
  assert.ok(biased.reasons.some((r) => /بازخورد|تنظیم/.test(r)));
});

test('rule create text parser', () => {
  const p = parseRuleCreateText('وردپرس خوب | وردپرس،wordpress | 5000000 | پیش‌نویس');
  assert.equal(p.ok, true);
  assert.equal(p.rule.action, 'CREATE_BID_DRAFT');
  assert.ok(p.rule.conditions.length >= 1);
});

test('morning digest quiet when empty', () => {
  assert.equal(formatMorningDigest({ opportunityCount: 0, pendingApprovals: 0 }), null);
  const t = formatMorningDigest({ opportunityCount: 2, pendingApprovals: 1, sessionHealthy: true });
  assert.ok(t.includes('صبح بخیر'));
});

test('decision inbox formats', () => {
  const t = formatDecisionInbox({
    opportunities: [{ id: '1', title: 'A', score: 90 }],
    approvals: [{ label: 'bids.submit' }],
    messages: [],
  });
  assert.ok(t.includes('صندوق تصمیم'));
});

test('menu maps فرصت and صندوق; callbacks parse', () => {
  assert.equal(mapMenuText(BTN.OPPORTUNITIES), 'opportunities');
  assert.equal(mapMenuText(BTN.INBOX), 'inbox');
  assert.equal(parseCallbackData('goto:inbox').type, 'goto_inbox');
  assert.equal(parseOpportunityCallback('opp:smart:123').type, 'opp_smart');
  assert.equal(parseOpportunityCallback('opp:profile').type, 'opp_profile');
});

test('token health warns on 401', () => {
  const h = checkTokenHealth({ got401: true });
  assert.equal(h.warn, true);
  assert.ok(h.reasonFa.includes('تمدید'));
});

test('scoring profile persists in store', () => {
  const { db } = tmpDb();
  const store = createOpportunityStore(db);
  store.setScoringProfile({
    preferredSkills: ['react'],
    preferredCategories: ['6'],
    budgetMin: 2e6,
    budgetMax: 15e6,
  });
  const p = store.getScoringProfile();
  assert.deepEqual(p.preferredSkills, ['react']);
  assert.equal(isScoringConfigured(p), true);
});
