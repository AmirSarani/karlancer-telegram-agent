import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOpportunityNotify,
  formatOpportunityScanResultBody,
  formatSkillsChips,
  formatWhyBullets,
  formatBudgetCompact,
  formatCategoryLine,
  decisionLabelShort,
  decisionLabelFa,
} from '../../src/opportunity/format-notify.js';
import {
  formatOpportunityCard,
  formatOpportunityScanResult,
  opportunityCardKeyboard,
} from '../../src/telegram/opportunity-ux.js';

const sampleCard = {
  opportunity: {
    id: '99',
    title: 'طراحی سایت فروش عمده',
    budgetMin: 7_000_000,
    budgetMax: 20_000_000,
    category: '6',
    skills: ['طراحی سایت', 'وردپرس', 'SEO', 'UI', 'UX', 'PHP'],
  },
  score: 40,
  decision: 'NOTIFY',
  reasons: [
    'مهارت‌های منطبق: طراحی سایت، وردپرس (+18)',
    'بودجه اعلام‌شده: ۷٬۰۰۰٬۰۰۰–۲۰٬۰۰۰٬۰۰۰ (+10)',
    'دسته: 6 (+6)',
    'خیلی تازه (0.5 ساعت) (+15)',
    'کارفرمای بدون امتیاز (+0)',
  ],
};

test('notify card is scannable: title, compact meta, chips, why bullets', () => {
  const text = formatOpportunityNotify(sampleCard);
  assert.match(text, /^🔥 فرصت جدید/);
  assert.match(text, /طراحی سایت فروش عمده/);
  assert.match(text, /۷–۲۰ میلیون تومان/);
  assert.match(text, /۴۰ از ۱۰۰/);
  assert.match(text, /فقط خبر/);
  assert.doesNotMatch(text, /————————/);
  assert.doesNotMatch(text, /دسته:\s*6/);
  assert.doesNotMatch(text, /کارفرمای بدون امتیاز/);
  assert.doesNotMatch(text, /\(\+0\)/);
  assert.doesNotMatch(text, /\(\+\d+\)/);
  assert.match(text, /چرا این امتیاز؟/);
  assert.match(text, /مهارت‌های مرتبط/);
  assert.match(text, /و ۲ تا دیگر|و ۲ تا دیگر/);
  // skills truncated
  assert.match(text, /🛠/);
  const whyCount = (text.match(/^• /gm) || []).length;
  assert.ok(whyCount >= 2 && whyCount <= 4);
});

test('formatOpportunityCard matches notify body; keyboard unchanged', () => {
  assert.equal(formatOpportunityCard(sampleCard), formatOpportunityNotify(sampleCard));
  const labels = opportunityCardKeyboard('99').inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((t) => /پیش‌نویس/.test(t)));
  assert.ok(labels.some((t) => /تأیید/.test(t)));
  assert.ok(labels.some((t) => /نادیده|رد/.test(t)));
  assert.ok(labels.some((t) => /جزئیات/.test(t)));
});

test('decision labels: notify tier is clearer than bare اطلاع‌رسانی', () => {
  assert.equal(decisionLabelShort('NOTIFY'), 'فقط خبر');
  assert.match(decisionLabelFa('NOTIFY'), /پیش‌نویس/);
  assert.equal(decisionLabelShort('CREATE_DRAFT'), 'پیش‌نویس');
});

test('skills chips truncate with و N تا دیگر', () => {
  const line = formatSkillsChips(['a', 'b', 'c', 'd', 'e', 'f'], { max: 4 });
  assert.match(line, /و ۲ تا دیگر/);
  assert.equal(formatSkillsChips([]), null);
});

test('category: hide raw numeric ids; show readable names', () => {
  assert.equal(formatCategoryLine('6'), null);
  assert.equal(formatCategoryLine(6), null);
  assert.match(formatCategoryLine('طراحی وب'), /طراحی وب/);
});

test('budget compact uses میلیون for million-range', () => {
  assert.match(formatBudgetCompact(7e6, 20e6), /میلیون تومان/);
  assert.equal(formatBudgetCompact(null, null), '—');
});

test('why bullets drop zero-value noise', () => {
  const bullets = formatWhyBullets([
    'کارفرمای بدون امتیاز (+0)',
    'مهارت‌های منطبق: react (+12)',
    'بودجه مشخص نیست (+0)',
    'خیلی تازه (1.2 ساعت) (+15)',
  ]);
  assert.equal(bullets.length, 2);
  assert.ok(bullets.every((b) => !/\(\+/.test(b)));
});

test('scan result summary is compact and Persian', () => {
  const text = formatOpportunityScanResult({
    scanned: 13,
    newCount: 5,
    matched: 0,
    drafts: 0,
    approvals: 0,
    autoExecuted: 0,
    notified: 5,
  });
  assert.equal(text, formatOpportunityScanResultBody({
    scanned: 13,
    newCount: 5,
    matched: 0,
    drafts: 0,
    approvals: 0,
    autoExecuted: 0,
    notified: 5,
  }));
  assert.match(text, /نتیجه اسکن/);
  assert.match(text, /اطلاع/);
  assert.doesNotMatch(text, /————————/);
  assert.match(text, /بررسی/);
});
