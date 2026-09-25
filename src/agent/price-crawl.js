/**
 * Learn the owner's past manual prices from Karlancer (READ-ONLY: GET requests only).
 *  - Past bids/proposals: GET /api/bids?page=N (amount = milestones sum, days, nested project).
 *  - Prices the owner wrote in chats: GET /api/rooms + first messages page per room.
 * Stores them as seed samples in price memory. Idempotent: every sample carries an ext_id
 * (bid:<id> / chat:<msgId>) so re-runs only refresh the won flag.
 * Never logs client names, ids or tokens.
 */
import { extractPriceFeatures, recordPriceSample, extractSentPrice } from './price-memory.js';
import { markOwnMessages, toLatinDigits } from './conversation.js';
import { getOwnUserId } from './own-identity.js';
import { logger } from '../observability/logger.js';

const LOST = new Set(['pending', 'declined', 'failed', 'canceled', 'cancelled', 'rejected', 'withdrawn', 'expired']);

/** A bid counts as won when Karlancer moved it past pending/declined (accepted, in progress, completed…). */
export function isWonBidStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  if (!s) return false;
  return !LOST.has(s);
}

/** "۱۰ روزه" / "10 days" → 10 */
export function extractDaysFromText(text) {
  const t = toLatinDigits(String(text || ''));
  const m = t.match(/(\d{1,3})\s*(?:روز|days?\b)/i);
  const n = m ? Number(m[1]) : null;
  return n && n > 0 && n <= 365 ? n : null;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function shortTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 57)}...` : s || null;
}

/**
 * @param {{ db, api, maxBidPages?: number, maxRoomPages?: number, maxRooms?: number, delayMs?: number, includeChats?: boolean }} opts
 */
export async function crawlPastPrices({
  db,
  api,
  maxBidPages = 40,
  maxRoomPages = 15,
  maxRooms = 150,
  delayMs = 700,
  includeChats = true,
} = {}) {
  const out = {
    ok: true,
    bids: { pages: 0, seen: 0, stored: 0, duplicates: 0, skipped: 0, won: 0 },
    chat: { rooms: 0, messages: 0, pricesFound: 0, stored: 0, duplicates: 0 },
    errors: 0,
  };
  if (!db || !api) return { ...out, ok: false, error: 'missing_deps' };

  // —— 1) past bids ——
  if (api.bids?.listMine) {
    for (let page = 1; page <= maxBidPages; page += 1) {
      let res;
      try {
        res = await api.bids.listMine({ page });
      } catch (e) {
        out.errors += 1;
        logger.warn('price_crawl_bids_failed', { page, code: e.code, status: e.status });
        break;
      }
      out.bids.pages += 1;
      for (const b of res.bids || []) {
        out.bids.seen += 1;
        if (!b?.id || !b.amount) {
          out.bids.skipped += 1;
          continue;
        }
        const won = isWonBidStatus(b.status);
        const project = { ...b.project, jobDuration: b.days || b.project?.jobDuration };
        const features = extractPriceFeatures({ project });
        if (b.days) features.days = b.days;
        const r = recordPriceSample(db, {
          amount: b.amount,
          source: 'bid',
          features,
          projectId: b.projectId,
          extId: `bid:${b.id}`,
          won,
          title: shortTitle(b.project?.title),
        });
        if (r.ok) {
          out.bids.stored += 1;
          if (won) out.bids.won += 1;
        } else if (r.reason === 'duplicate') out.bids.duplicates += 1;
        else out.bids.skipped += 1;
      }
      const last = Number(res.pagination?.lastPage) || page;
      if (page >= last || !(res.bids || []).length) break;
      await sleep(delayMs);
    }
  }

  // —— 2) prices the owner wrote in chats ——
  if (includeChats && api.rooms?.list && api.messages?.list) {
    const ownUserId = await getOwnUserId({ api, db }).catch(() => null);
    if (!ownUserId) {
      out.chat.skippedReason = 'own_user_unknown';
    } else {
      const projectCache = new Map();
      outer: for (let page = 1; page <= maxRoomPages; page += 1) {
        let rp;
        try {
          rp = await api.rooms.list({ page });
        } catch (e) {
          out.errors += 1;
          logger.warn('price_crawl_rooms_failed', { page, code: e.code, status: e.status });
          break;
        }
        for (const room of rp.rooms || []) {
          if (out.chat.rooms >= maxRooms) break outer;
          out.chat.rooms += 1;
          await sleep(delayMs);
          let data;
          try {
            data = await api.messages.list(room.id, { page: 1 });
          } catch (e) {
            out.errors += 1;
            continue;
          }
          const msgs = markOwnMessages(data.messages || [], ownUserId);
          out.chat.messages += msgs.length;
          for (const m of msgs) {
            if (m.isOwn !== true || !m.id) continue;
            const amount = extractSentPrice(m.text);
            if (!amount) continue;
            out.chat.pricesFound += 1;
            let project = null;
            const slug = msgs.map((x) => x.projectSlug).find(Boolean) || null;
            if (slug && api.projects?.getBySlug) {
              if (projectCache.has(slug)) project = projectCache.get(slug);
              else {
                try {
                  await sleep(delayMs);
                  project = (await api.projects.getBySlug(slug)).project || null;
                } catch {
                  project = null;
                }
                projectCache.set(slug, project);
              }
            }
            const clientText = msgs
              .filter((x) => x.isOwn !== true)
              .map((x) => x.text)
              .join(' ')
              .slice(0, 3000);
            const features = extractPriceFeatures({ project, clientText });
            const days = extractDaysFromText(m.text);
            if (days) features.days = days;
            const r = recordPriceSample(db, {
              amount,
              source: 'chat',
              features,
              roomId: String(room.id),
              projectId: project?.id || null,
              extId: `chat:${m.id}`,
              title: shortTitle(project?.title),
            });
            if (r.ok) out.chat.stored += 1;
            else if (r.reason === 'duplicate') out.chat.duplicates += 1;
          }
        }
        const last = Number(rp.pagination?.lastPage || rp.pagination?.totalPages) || page;
        if (page >= last || !(rp.rooms || []).length) break;
      }
    }
  }

  logger.info('price_crawl_done', { bids: out.bids, chat: out.chat, errors: out.errors });
  return out;
}

/** Anonymized samples for reports: short title, amount, days (no names/ids). */
export function samplePreview(db, { limit = 5 } = {}) {
  try {
    return db
      .prepare(
        `SELECT title, amount_toman AS amount, source, won, days FROM price_samples
         WHERE source IN ('bid','chat') ORDER BY won DESC, id DESC LIMIT ?`
      )
      .all(limit)
      .map((r) => ({
        title: shortTitle(r.title)?.slice(0, 40) || null,
        amount: r.amount,
        days: r.days ?? null,
        source: r.source,
        won: !!r.won,
      }));
  } catch {
    return [];
  }
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = (n) => String(n ?? 0).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

/** Persian owner notice after a crawl (counts only, no names/ids). */
export function formatPriceCrawlNotice({ bids = {}, chat = {}, errors = 0 } = {}) {
  const lines = [
    '🔄 یادگیری از قیمت‌های قبلی تمام شد',
    '',
    `• پیشنهادهای قبلی شما: ${fa(bids.seen || 0)} مورد دیدم، ${fa(bids.stored || 0)} قیمت تازه یاد گرفتم${bids.won ? ` (${fa(bids.won)} کار برنده)` : ''}.`,
    `• قیمت‌هایی که در گفتگوها نوشته بودید: ${fa(chat.pricesFound || 0)} مورد پیدا شد، ${fa(chat.stored || 0)} مورد تازه ثبت شد.`,
  ];
  const dup = (bids.duplicates || 0) + (chat.duplicates || 0);
  if (dup) lines.push(`• ${fa(dup)} مورد از قبل ثبت شده بود و تکراری حساب نشد.`);
  if (errors) lines.push(`• ${fa(errors)} صفحه خوانده نشد؛ دوباره اجرا کردن مشکلی ندارد.`);
  lines.push('', 'از این به بعد قیمت هر کار با کارهای مشابه قبلی شما مقایسه می‌شود.');
  return lines.join('\n');
}
