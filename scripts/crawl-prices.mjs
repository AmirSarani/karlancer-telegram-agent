#!/usr/bin/env node
/**
 * One-off / re-runnable: learn the owner's past manual prices (READ-ONLY GET requests).
 *   node scripts/crawl-prices.mjs            # crawl + print counts and anonymized samples
 *   node scripts/crawl-prices.mjs --no-chats # bids only
 * Idempotent (ext_id per bid / chat message). Prints counts only: no names, ids or tokens.
 */
import { loadAppConfig } from '../src/config.js';
import { openDb } from '../src/memory/db.js';
import { createKarlancerApi } from '../src/api/adapters/index.js';
import { crawlPastPrices, samplePreview } from '../src/agent/price-crawl.js';

const args = new Set(process.argv.slice(2));
const config = loadAppConfig({ requireTelegram: false, requireOwner: false });
const db = openDb(config.dbPath);
const api = createKarlancerApi({
  baseUrl: config.karlancerBaseUrl,
  accessToken: config.karlancerAccessToken,
  cookie: config.karlancerCookie,
  timeoutMs: config.karlancerTimeoutMs,
});

const out = await crawlPastPrices({ db, api, includeChats: !args.has('--no-chats') });
const total = db.prepare(`SELECT source, COUNT(*) AS n FROM price_samples GROUP BY source`).all();
console.log(JSON.stringify({ bids: out.bids, chat: out.chat, errors: out.errors, totalBySource: total }, null, 2));
for (const s of samplePreview(db, { limit: 5 })) {
  console.log(`- ${s.title || '(بدون عنوان)'} | ${s.amount} تومان | ${s.days ?? '?'} روز | ${s.source}${s.won ? ' | برنده' : ''}`);
}
db.close();
