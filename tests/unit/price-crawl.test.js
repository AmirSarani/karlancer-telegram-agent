/**
 * Items 2–3: past-price crawl (read-only, idempotent), effort tiers, per-job range, relative discount.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { crawlPastPrices, isWonBidStatus, extractDaysFromText, samplePreview, formatPriceCrawlNotice } from '../../src/agent/price-crawl.js';
import { normalizeMyBid, createBidsAdapter } from '../../src/api/adapters/bids.js';
import { createProjectsAdapter } from '../../src/api/adapters/projects.js';
import { deriveJobTier, ruleRangeForTier, extractSentPrice, recordPriceSample, learnedPriceFor, extractPriceFeatures } from '../../src/agent/price-memory.js';
import { decideChatPrice } from '../../src/agent/chat-price.js';
import { evaluateDiscount } from '../../src/agent/conversation.js';
import { parseCallbackData, rulesInlineKeyboard } from '../../src/telegram/ui.js';
import { PRICING_WIZARD_HELP } from '../../src/telegram/rule-wizard.js';
import { handleJob } from '../../src/worker/handlers.js';
import { createJobQueue } from '../../src/worker/queue.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcrawl-'));
  return openDb(path.join(dir, 'a.sqlite'));
}

const rawBid = (id, status, budget = 3_000_000) => ({
  id,
  budget,
  duration: 7,
  status,
  milestones: [{ budget: budget / 2, duration: 3 }, { budget: budget / 2, duration: 4 }],
  project: { id: 900 + id, title: `طراحی لندینگ وردپرس ${id}`, description: 'یک صفحه فرود ساده', status: 'pending', min_budget: 1_000_000, max_budget: 5_000_000, skills: [{ name: 'wordpress', display: 'وردپرس' }] },
});

function fakeApi({ ownId = '77' } = {}) {
  const calls = [];
  return {
    calls,
    client: { hasAuth: true },
    user: { me: async () => ({ id: ownId }) },
    bids: {
      async listMine({ page }) {
        calls.push(`GET bids ${page}`);
        const list = page === 1 ? [rawBid(1, 'completed'), rawBid(2, 'declined')] : [rawBid(3, 'pending', 8_000_000)];
        return { bids: list.map(normalizeMyBid), pagination: { lastPage: 2 } };
      },
    },
    rooms: {
      async list({ page }) {
        calls.push(`GET rooms ${page}`);
        return { rooms: page === 1 ? [{ id: 'r1' }] : [], pagination: { lastPage: 1 } };
      },
    },
    messages: {
      async list(roomId) {
        calls.push(`GET messages ${roomId}`);
        return {
          messages: [
            { id: 'm1', senderId: '5', text: 'سلام، قیمت چقدر می‌شود؟', projectSlug: 'abc' },
            { id: 'm2', senderId: '77', text: 'برای این کار ۲ میلیون تومان و ۵ روزه تحویل می‌دهم' },
          ],
        };
      },
    },
    projects: {
      async getBySlug() {
        calls.push('GET project');
        return { project: { id: 'p1', title: 'رفع باگ فرم تماس', description: 'فرم کار نمی‌کند' } };
      },
    },
  };
}

test('normalizeMyBid: amount = milestone sum (Toman), days, skills display', () => {
  const b = normalizeMyBid(rawBid(5, 'pending', 4_000_000));
  assert.equal(b.amount, 4_000_000);
  assert.equal(b.days, 7);
  assert.deepEqual(b.project.skills, ['وردپرس']);
});

test('bids adapter listMine is a GET with paging', async () => {
  const seen = [];
  const client = { get: async (url) => { seen.push(url); return { data: { data: { data: [rawBid(1, 'pending')], current_page: 2, last_page: 26 } } }; } };
  const out = await createBidsAdapter(client).listMine({ page: 2 });
  assert.equal(seen[0], '/api/bids?page=2');
  assert.equal(out.pagination.lastPage, 26);
  assert.equal(out.bids.length, 1);
});

test('projects adapter follows the 400 redirect body to the slug', async () => {
  const client = {
    get: async (url) => {
      if (url.endsWith('/123')) {
        const e = new Error('HTTP 400');
        e.status = 400;
        e.body = { status: 'redirect', data: 'my-slug' };
        throw e;
      }
      return { data: { data: { id: 123, title: 'x', breadcrumbs: [{ name: 'برنامه‌نویسی' }, { name: 'وردپرس' }] } } };
    },
  };
  const got = await createProjectsAdapter(client).get('123');
  assert.equal(got.slug, 'my-slug');
  assert.equal(got.project?.category, 'وردپرس');
});

test('crawlPastPrices: read-only, stores bids + chat prices, re-run is idempotent', async () => {
  const db = tmpDb();
  const api = fakeApi();
  const a = await crawlPastPrices({ db, api, delayMs: 0 });
  assert.equal(a.bids.seen, 3);
  assert.equal(a.bids.stored, 3);
  assert.equal(a.bids.won, 1);
  assert.equal(a.chat.pricesFound, 1);
  assert.equal(a.chat.stored, 1);
  assert.ok(api.calls.every((c) => c.startsWith('GET')));
  const b = await crawlPastPrices({ db, api, delayMs: 0 });
  assert.equal(b.bids.stored, 0);
  assert.equal(b.bids.duplicates, 3);
  assert.equal(b.chat.stored, 0);
  const n = db.prepare('SELECT COUNT(*) AS n FROM price_samples').get().n;
  assert.equal(n, 4);
  const chat = db.prepare(`SELECT amount_toman, days, title FROM price_samples WHERE source='chat'`).get();
  assert.equal(chat.amount_toman, 2_000_000);
  assert.equal(chat.days, 5);
  const prev = samplePreview(db, { limit: 5 });
  assert.ok(prev.length >= 3);
  assert.ok(prev.every((s) => !('roomId' in s) && !('id' in s)));
  const notice = formatPriceCrawlNotice(a);
  assert.match(notice, /یادگیری از قیمت‌های قبلی/);
  assert.doesNotMatch(notice, /[—–]/);
});

test('bid status → won', () => {
  assert.equal(isWonBidStatus('completed'), true);
  assert.equal(isWonBidStatus('in progress'), true);
  assert.equal(isWonBidStatus('pending'), false);
  assert.equal(isWonBidStatus('declined'), false);
  assert.equal(extractDaysFromText('تحویل ۱۰ روزه'), 10);
});

test('extractSentPrice: Toman, Rial (÷10), million', () => {
  assert.equal(extractSentPrice('۱,۵۰۰,۰۰۰ تومان'), 1_500_000);
  assert.equal(extractSentPrice('۲ میلیون'), 2_000_000);
  assert.equal(extractSentPrice('15,000,000 ریال'), 1_500_000);
  assert.equal(extractSentPrice('3 million toman'), 3_000_000);
});

test('deriveJobTier + rule ranges: small cheap job stays small', () => {
  const small = deriveJobTier({ project: { title: 'رفع باگ جزئی', description: 'یک تغییر کوچک در فرم', maxBudget: 1_500_000 }, days: 2 });
  assert.equal(small.tier, 'small');
  const large = deriveJobTier({ project: { title: 'فروشگاه کامل', description: 'x'.repeat(2000), maxBudget: 100_000_000 }, analysis: { complexity: 'high' }, days: 45 });
  assert.equal(large.tier, 'large');
  const r = ruleRangeForTier('small');
  assert.ok(r.low <= 1_000_000 && r.mid <= 5_000_000);
});

test('learnedPriceFor returns p25..p75 range from similar samples', () => {
  const db = tmpDb();
  const f = extractPriceFeatures({ project: { title: 'طراحی سایت وردپرس', description: 'سایت شرکتی وردپرس', jobDuration: 10 } });
  for (const [i, amt] of [4_000_000, 5_000_000, 6_000_000, 7_000_000].entries()) {
    recordPriceSample(db, { amount: amt, source: 'bid', features: f, extId: `bid:${i}` });
  }
  const l = learnedPriceFor(db, f);
  assert.equal(l.count, 4);
  assert.ok(l.p25 <= l.amount && l.amount <= l.p75);
  const p = decideChatPrice({ db, card: { roomId: 'x', project: { title: 'طراحی سایت وردپرس', description: 'سایت شرکتی وردپرس', jobDuration: 10 } } });
  assert.equal(p.range.source, 'learned');
});

test('no budget, no history: price follows the job tier (no flat floor)', () => {
  const p = decideChatPrice({ card: { roomId: 'y', project: { title: 'رفع باگ کوچک', description: 'یک اصلاح جزئی', jobDuration: 2 } } });
  assert.equal(p.tier, 'small');
  assert.ok(p.amount <= 5_000_000, `amount ${p.amount}`);
  assert.equal(p.range.source, 'rules');
});

test('evaluateDiscount: floor never rejects a small job; cap is relative to job price', () => {
  const small = evaluateDiscount({ askedDiscount: true, requestedPct: 10 }, { basePrice: 1_000_000, maxDiscountPct: 10, priceFloorToman: 5_000_000 });
  assert.equal(small.allowed, true);
  assert.equal(small.minPrice, 900_000);
  const big = evaluateDiscount({ askedDiscount: true, requestedPct: 10 }, { basePrice: 5_200_000, maxDiscountPct: 10, priceFloorToman: 5_000_000 });
  assert.equal(big.allowed, false);
  assert.equal(big.reason, 'below_price_floor');
});

test('Telegram: «🔄 یادگیری از قیمت‌های قبلی» button + callback; wizard copy says floor is optional', () => {
  const kb = JSON.stringify(rulesInlineKeyboard());
  assert.match(kb, /wiz:price_sync/);
  assert.match(kb, /یادگیری از قیمت‌های قبلی/);
  assert.equal(parseCallbackData('wiz:price_sync').type, 'wiz_price_sync');
  assert.match(PRICING_WIZARD_HELP, /اختیاری/);
  assert.match(PRICING_WIZARD_HELP, /همان کار/);
});

test('worker job pricing.crawl runs read-only and emits pricing.crawled', async () => {
  const db = tmpDb();
  const queue = createJobQueue(db);
  const events = [];
  const api = fakeApi();
  const out = await handleJob(
    { db, queue, api, emit: async (t, p) => events.push({ t, p }), onEvent: async (t, p) => events.push({ t, p }) },
    { id: 'j1', goal: 'pricing.crawl', payload: { delayMs: 0 } }
  );
  assert.equal(out.ok, true);
  assert.equal(out.result.bids.stored, 3);
});
