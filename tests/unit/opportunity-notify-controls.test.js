import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  opportunityCardKeyboard,
  opportunityScanResultKeyboard,
  parseOpportunityCallback,
  formatOpportunityScanResult,
  OPP_BATCH_PREP_CAP,
} from '../../src/telegram/opportunity-ux.js';

test('NOTIFY-tier cards still get actionable HITL buttons', () => {
  const kb = opportunityCardKeyboard('99');
  const labels = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((t) => /پیش‌نویس/.test(t)));
  assert.ok(labels.some((t) => /تأیید/.test(t)));
  assert.ok(labels.some((t) => /نادیده|رد/.test(t)));
  assert.ok(labels.some((t) => /جزئیات/.test(t)));
  // no live-send button on the card itself
  assert.ok(!labels.some((t) => /ارسال زنده|live/i.test(t)));
});

test('scan result keyboard offers book, list, approvals, batch prep, home, scoring rules', () => {
  const empty = opportunityScanResultKeyboard({ matched: 0, notified: 0, drafts: 0 });
  const emptyData = empty.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(emptyData.includes('book:home'));
  assert.ok(emptyData.includes('opp:list'));
  assert.ok(emptyData.includes('goto:approvals'));
  assert.ok(!emptyData.includes('opp:prep_matched'), 'hide batch when nothing to prep');

  const full = opportunityScanResultKeyboard({ matched: 0, notified: 5, drafts: 0 });
  const fullData = full.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(fullData.includes('opp:prep_matched'));
  assert.ok(fullData.includes('book:home'));
  assert.equal(parseOpportunityCallback('opp:prep_matched').type, 'opp_prep_matched');
  assert.ok(OPP_BATCH_PREP_CAP >= 1 && OPP_BATCH_PREP_CAP <= 10);
});

test('scan result copy stays Persian and includes notify count', () => {
  const text = formatOpportunityScanResult({
    scanned: 13,
    newCount: 5,
    matched: 0,
    drafts: 0,
    approvals: 0,
    autoExecuted: 0,
    notified: 5,
  });
  assert.ok(/نتیجه اسکن/.test(text));
  assert.ok(/اطلاع‌رسانی|اطلاع/.test(text));
});
