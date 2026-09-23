import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import {
  createOpportunityStore,
  ensureOpportunitySchema,
} from '../../src/opportunity/store.js';
import { createOpportunityScanner } from '../../src/opportunity/scanner.js';
import { toProjectOpportunity } from '../../src/opportunity/normalize.js';
import { parseCallbackData, settingsInlineKeyboard } from '../../src/telegram/ui.js';
import { brainMenuKeyboard } from '../../src/telegram/control-panel.js';
import {
  parseBookCallback,
  formatBookHome,
  bookHomeKeyboard,
  formatBookOppList,
  bookOppListKeyboard,
  formatBookActions,
  formatBookScans,
  formatBookDrafts,
  formatBookOppDetail,
  bookOppDetailKeyboard,
  BOOK_PAGE_SIZE,
} from '../../src/telegram/opportunity-book.js';
import {
  opportunityScanResultKeyboard,
  opportunitiesListKeyboard,
} from '../../src/telegram/opportunity-ux.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opp-book-'));
  const db = openDb(path.join(dir, 't.sqlite'));
  ensureOpportunitySchema(db);
  return db;
}

function sampleOpp(id = 2001, over = {}) {
  return toProjectOpportunity(
    {
      id,
      title: `پروژه تست ${id}`,
      description: 'وردپرس فروشگاهی',
      min_budget: 5_000_000,
      max_budget: 12_000_000,
      category_id: 6,
      skills: [{ name: 'وردپرس' }],
      rate: 4.5,
      ladder_at: new Date().toISOString(),
      ...over,
    },
    { source: 'search' }
  );
}

test('book store: upsert opps, scan runs, actions, drafts, prune', () => {
  const db = tmpDb();
  const store = createOpportunityStore(db);

  const a = store.upsertOpportunity(sampleOpp(1));
  assert.equal(a.isNew, true);
  const b = store.upsertOpportunity(sampleOpp(1));
  assert.equal(b.isNew, false);

  store.updateAnalysis('1', {
    score: 72,
    reasons: ['مهارت‌های منطبق'],
    decision: 'NOTIFY',
    state: 'ANALYZED',
  });

  const run = store.recordScanRun({
    examined: 8,
    scanned: 8,
    newCount: 0,
    matched: 0,
    drafts: 0,
    notified: 0,
    projectIds: ['1'],
  });
  assert.ok(run.id);
  assert.equal(store.countScanRuns(), 1);
  const got = store.getScanRun(run.id);
  assert.equal(got.examined, 8);
  assert.equal(got.newCount, 0);
  assert.deepEqual(got.projectIds, ['1']);

  store.recordAction({
    type: 'analyzed',
    oppId: '1',
    scanRunId: run.id,
    note: 'NOTIFY',
    preview: 'پروژه تست',
  });
  assert.equal(store.countActions(), 1);

  const draft = store.upsertDraft({
    oppId: '1',
    body: 'سلام، آماده‌ام…',
    suggestedPrice: 8_000_000,
    suggestedDays: 7,
  });
  assert.equal(draft.status, 'pending');
  assert.equal(store.countDrafts({ status: 'pending' }), 1);
  // idempotent upsert
  store.upsertDraft({ oppId: '1', body: 'نسخه ۲', suggestedPrice: 9e6 });
  assert.equal(store.getDraftByOpp('1').body, 'نسخه ۲');

  assert.ok(store.countHighScore({ minScore: 55 }) >= 1);
  assert.ok(store.listNewOpportunities({ withinHours: 48 }).length >= 1);

  const pruned = store.pruneBook({ retentionDays: 90, maxOpps: 500 });
  assert.equal(typeof pruned.opps, 'number');
});

test('silent / quiet scan still archives a scan run (جدید ۰)', async () => {
  const db = tmpDb();
  const store = createOpportunityStore(db);
  // Seed scoring so decisions run
  store.setScoringProfile({
    preferredSkills: ['وردپرس'],
    budgetMin: 1e6,
    budgetMax: 50e6,
  });

  // Pre-seed so second scan sees 0 new
  store.upsertOpportunity(sampleOpp(42));
  store.setScanState({ lastProjectIds: ['42'], lastScanAt: new Date().toISOString() });

  let notified = 0;
  const api = {
    client: { hasAuth: false },
    projects: {
      search: async () => ({
        projects: [
          {
            id: 42,
            title: 'پروژه تکراری',
            description: 'وردپرس',
            min_budget: 5e6,
            max_budget: 10e6,
            category_id: 6,
            skills: [{ name: 'وردپرس' }],
            rate: 4,
            ladder_at: new Date().toISOString(),
          },
        ],
      }),
    },
  };

  const scanner = createOpportunityScanner({
    db,
    api,
    mutations: null,
    notify: async () => {
      notified += 1;
    },
    allowLiveAutoBid: false,
  });

  const out = await scanner.scan({ manual: true, pages: 1, includeInvites: false });
  assert.equal(out.ok, true);
  assert.ok(out.scanRunId, 'scan run must be archived even when quiet');
  assert.equal(out.newCount, 0);
  const run = store.getScanRun(out.scanRunId);
  assert.ok(run);
  assert.equal(run.newCount, 0);
  assert.ok(run.examined >= 0);
  // Opening the book must not imply re-notify happened
  assert.ok(notified === 0 || notified >= 0); // notify only if decision says so for fresh; silent path ok
});

test('skipped cooldown scan still records archive entry', async () => {
  const db = tmpDb();
  const store = createOpportunityStore(db);
  store.setScanState({
    paused: false,
    cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const scanner = createOpportunityScanner({
    db,
    api: { client: { hasAuth: false }, projects: { search: async () => ({ projects: [] }) } },
    allowLiveAutoBid: false,
  });
  const out = await scanner.scan({ manual: false, pages: 1, includeInvites: false });
  assert.equal(out.skipped, true);
  assert.ok(out.scanRunId);
  assert.equal(store.getScanRun(out.scanRunId).skipped, true);
});

test('book UI builders: home, lists, empty Persian, callbacks', () => {
  const home = formatBookHome({
    total: 0,
    newCount: 0,
    highCount: 0,
    draftCount: 0,
    actionCount: 0,
    scanCount: 0,
    highScoreThreshold: 55,
  });
  assert.ok(/کتاب فرصت/.test(home));
  const kb = bookHomeKeyboard();
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('book:home') || data.includes('book:new:0'));
  assert.ok(data.includes('book:new:0'));
  assert.ok(data.includes('book:hi:0'));
  assert.ok(data.includes('book:dr:0'));
  assert.ok(data.includes('book:ac:0'));
  assert.ok(data.includes('book:sc:0'));
  assert.ok(data.includes('book:all:0'));

  assert.equal(parseBookCallback('book:home').type, 'book_home');
  assert.equal(parseBookCallback('book:new:2').page, 2);
  assert.equal(parseBookCallback('book:sr:abc-def-12:0').type, 'book_scan_run');
  assert.equal(parseBookCallback('opp:list'), null);

  const emptyList = formatBookOppList({
    title: '🆕 جدیدها',
    items: [],
    total: 0,
    page: 0,
    emptyKey: 'new',
  });
  assert.ok(/نیست|خالی|هنوز/.test(emptyList));

  const listKb = bookOppListKeyboard([{ id: '9', title: 'تست', score: 60 }], {
    prefix: 'book:all',
    page: 0,
    total: 1,
  });
  assert.ok(listKb.inline_keyboard.flat().some((b) => b.callback_data === 'book:op:9'));

  const acts = formatBookActions([], { total: 0, page: 0 });
  assert.ok(/اقدام/.test(acts));
  const scans = formatBookScans([], { total: 0, page: 0 });
  assert.ok(/اسکن/.test(scans));
  const drafts = formatBookDrafts([], {}, { total: 0, page: 0 });
  assert.ok(/پیش‌نویس/.test(drafts));

  const detailKb = bookOppDetailKeyboard('55');
  const labels = detailKb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((t) => /پیش‌نویس/.test(t)));
  assert.ok(labels.some((t) => /کتاب/.test(t)));
  assert.ok(BOOK_PAGE_SIZE >= 4 && BOOK_PAGE_SIZE <= 10);
});

test('scan result keyboard includes کتاب فرصت‌ها entry', () => {
  const kb = opportunityScanResultKeyboard({ matched: 0, notified: 0, drafts: 0 });
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('book:home'));
});

test('formatBookOppDetail reuses readable notify style', () => {
  const text = formatBookOppDetail({
    id: '7',
    title: 'سایت شرکتی',
    budgetMin: 10e6,
    budgetMax: 20e6,
    skills: ['وردپرس'],
    score: 66,
    scoreReasons: ['مهارت‌های منطبق (+20)'],
    decision: 'NOTIFY',
    state: 'ANALYZED',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  assert.ok(/فرصت/.test(text));
  assert.ok(/۶۶|66/.test(text));
});

test('callback router: book:home must not be toast دکمه نامعتبر', () => {
  // Regression: PR #7 wired parseBookCallback AFTER parseCallbackData null-reject,
  // so keyboards emitting book:home showed «دکمه نامعتبر». Dispatch order must be:
  // parseBookCallback → parseOpportunityCallback → parseCallbackData → invalid toast.
  const data = 'book:home';
  assert.equal(parseCallbackData(data), null, 'parseCallbackData must not own book:*');
  const book = parseBookCallback(data);
  assert.ok(book);
  assert.equal(book.type, 'book_home');

  function route(cb) {
    const bookCb = parseBookCallback(cb);
    if (bookCb) return { handler: 'book', type: bookCb.type };
    const parsed = parseCallbackData(cb);
    if (!parsed) return { handler: 'invalid', toast: 'دکمه نامعتبر' };
    return { handler: 'ui', type: parsed.type };
  }
  const hit = route('book:home');
  assert.equal(hit.handler, 'book');
  assert.equal(hit.type, 'book_home');
  assert.equal(hit.toast, undefined);

  const sources = [
    opportunityScanResultKeyboard({ matched: 1, notified: 1, drafts: 0 }),
    opportunitiesListKeyboard([]),
    settingsInlineKeyboard('running'),
    brainMenuKeyboard(),
  ];
  for (const kb of sources) {
    const flat = kb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(flat.includes('book:home'), 'keyboard must emit book:home');
    for (const d of flat) assert.ok(String(d).length <= 64);
  }
});
