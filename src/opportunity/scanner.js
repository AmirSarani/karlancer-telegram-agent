/**
 * Intelligent opportunity scanner.
 * API → normalize → rules → score → decide → notify/draft/mock-auto via PermissionGate.
 * Never live-spams bids: AUTO_EXECUTE always forceRequireApproval in this build.
 */
import { logger } from '../observability/logger.js';
import { toProjectOpportunity } from './normalize.js';
import { createOpportunityStore, ensureOpportunitySchema } from './store.js';
import { matchRules } from './rules-engine.js';
import { scoreOpportunity, isScoringConfigured } from './scoring.js';
import { decideOpportunity } from './decision-engine.js';
import {
  createAgentSettingsStore,
  getTodayAutoCounts,
} from '../telegram/agent-settings.js';
import { createPermissionGate } from '../telegram/permission-gate.js';

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<import('../api/adapters/index.js').createKarlancerApi>} deps.api
 * @param {{ request: Function }} [deps.mutations]
 * @param {string} [deps.tenantId]
 * @param {(text: string, meta?: object) => Promise<void>|void} [deps.notify]
 */
export function createOpportunityScanner(deps) {
  const { db, api, mutations = null, tenantId = 'default', notify = null } = deps;

  ensureOpportunitySchema(db);
  const store = createOpportunityStore(db, { tenantId });
  const settingsStore = createAgentSettingsStore(db, { tenantId });
  const gate = createPermissionGate(db, { tenantId });

  function syncScoringAvailable() {
    const profile = store.getScoringProfile();
    const available = isScoringConfigured(profile);
    const s = settingsStore.get();
    const messageAuto = s.rules?.messageAuto || {};
    const bidAuto = s.rules?.bidAuto || {};
    if (
      messageAuto.scoringAvailable === available &&
      bidAuto.scoringAvailable === available
    ) {
      return available;
    }
    settingsStore.update({
      rules: {
        messageAuto: { ...messageAuto, scoringAvailable: available },
        bidAuto: { ...bidAuto, scoringAvailable: available },
      },
    });
    return available;
  }

  /**
   * @param {{
   *   pages?: number,
   *   includeInvites?: boolean,
   *   searchParams?: object,
   *   manual?: boolean,
   * }} [opts]
   */
  async function scan(opts = {}) {
    const settings = settingsStore.get();
    const scanState = store.getScanState();
    const now = new Date();
    const nowIso = now.toISOString();

    if (!opts.manual && scanState.paused) {
      return { ok: true, skipped: true, reason: 'scan_paused', scannedAt: nowIso };
    }
    if (
      !opts.manual &&
      scanState.cooldownUntil &&
      Date.parse(scanState.cooldownUntil) > Date.now()
    ) {
      return { ok: true, skipped: true, reason: 'cooldown', scannedAt: nowIso };
    }

    syncScoringAvailable();

    const pages = Math.min(5, Math.max(1, Number(opts.pages) || 1));
    const includeInvites = opts.includeInvites !== false;
    const profile = store.getScoringProfile();
    const rules = store.listRules({ enabledOnly: true });
    const todayCounts = getTodayAutoCounts(db, { tenantId });

    /** @type {object[]} */
    const fetched = [];
    const errors = [];

    for (let page = 1; page <= pages; page += 1) {
      try {
        const res = await api.projects.search({ page, ...(opts.searchParams || {}) });
        for (const p of res.projects || []) {
          const opp = toProjectOpportunity(p, { source: 'search', now });
          if (opp) fetched.push(opp);
        }
      } catch (e) {
        errors.push({ source: 'search', page, err: e.message });
        logger.warn('opportunity_search_failed', { page, err: e.message });
      }
    }

    if (includeInvites && api.client?.hasAuth) {
      try {
        const invites = await fetchInviteOpportunities(api, { now });
        fetched.push(...invites);
      } catch (e) {
        errors.push({ source: 'invites', err: e.message });
        logger.warn('opportunity_invites_failed', { err: e.message });
      }
    }

    const byId = new Map();
    for (const o of fetched) {
      const prev = byId.get(o.id);
      if (!prev || (o.source === 'invite' && prev.source !== 'invite')) {
        byId.set(o.id, o);
      }
    }
    const unique = [...byId.values()];
    const previousIds = new Set(scanState.lastProjectIds || []);

    const results = {
      ok: true,
      scanned: unique.length,
      newCount: 0,
      analyzed: 0,
      matched: 0,
      ignored: 0,
      notified: 0,
      drafts: 0,
      approvals: 0,
      autoMock: 0,
      decisions: [],
      errors,
      scannedAt: nowIso,
    };

    for (const opp of unique) {
      const upsert = store.upsertOpportunity(opp, { state: 'NEW' });
      const isFresh = upsert.isNew || !previousIds.has(opp.id);
      if (upsert.isNew) results.newCount += 1;
      if (upsert.state === 'SUBMITTED') continue;

      const alreadyActed = store.hasSubmittedOrAction(opp.id);
      const scored = scoreOpportunity(opp, profile);
      const { matched } = matchRules(opp, rules);

      const decisionOut = decideOpportunity({
        opportunity: opp,
        score: scored.score,
        reasons: scored.reasons,
        matchedRules: matched,
        settings,
        gate,
        todayCounts,
        alreadyActed,
        cooldownActive: false,
      });

      // Emergency stop: never AUTO_EXECUTE
      if (settings.emergencyStop && decisionOut.decision === 'AUTO_EXECUTE') {
        decisionOut.decision = 'REQUEST_APPROVAL';
        decisionOut.mockAutoExecute = false;
        decisionOut.reasons = [
          ...decisionOut.reasons,
          'توقف اضطراری — AUTO_EXECUTE به درخواست تأیید تبدیل شد',
        ];
      }

      const state = stateForDecision(decisionOut.decision, matched.length > 0);
      store.updateAnalysis(opp.id, {
        score: scored.score,
        reasons: decisionOut.reasons,
        matchedRules: matched,
        decision: decisionOut.decision,
        decisionDetail: {
          mockAutoExecute: decisionOut.mockAutoExecute,
          breakdown: scored.breakdown,
          gate: decisionOut.gateVerdict
            ? {
                decision: decisionOut.gateVerdict.decision,
                reason: decisionOut.gateVerdict.reason,
                reasonFa: decisionOut.gateVerdict.reasonFa,
              }
            : null,
          isFresh,
        },
        state,
      });

      store.recordDecision({
        projectId: opp.id,
        score: scored.score,
        matchedRules: matched,
        decision: decisionOut.decision,
        reasons: decisionOut.reasons,
        mode: settings.mode,
        detail: {
          mockAutoExecute: decisionOut.mockAutoExecute,
          source: opp.source,
          title: opp.title,
        },
      });

      results.analyzed += 1;
      if (matched.length) results.matched += 1;
      if (decisionOut.decision === 'IGNORE') results.ignored += 1;

      const card = {
        opportunity: opp,
        score: scored.score,
        reasons: decisionOut.reasons,
        decision: decisionOut.decision,
        matchedRules: matched,
        breakdown: scored.breakdown,
      };
      results.decisions.push(card);

      try {
        await applySideEffects({
          card,
          decisionOut,
          mutations,
          store,
          notify,
          isFresh,
        });
        if (decisionOut.decision === 'NOTIFY') results.notified += 1;
        if (decisionOut.decision === 'CREATE_DRAFT') results.drafts += 1;
        if (decisionOut.decision === 'REQUEST_APPROVAL') results.approvals += 1;
        if (decisionOut.decision === 'AUTO_EXECUTE') results.autoMock += 1;
      } catch (e) {
        errors.push({ source: 'side_effect', projectId: opp.id, err: e.message });
        logger.warn('opportunity_side_effect_failed', {
          projectId: opp.id,
          err: e.message,
        });
      }
    }

    store.setScanState({
      lastScanAt: nowIso,
      lastProjectIds: unique.map((u) => u.id).slice(0, 200),
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    });

    logger.info('opportunity_scan_done', {
      scanned: results.scanned,
      newCount: results.newCount,
      matched: results.matched,
      drafts: results.drafts,
      errors: errors.length,
    });

    return results;
  }

  return {
    store,
    scan,
    syncScoringAvailable,
    gate,
    settingsStore,
  };
}

async function fetchInviteOpportunities(
  api,
  { now, page = 1, keywords = ['دعوت', 'همکاری', 'پروژه'] } = {}
) {
  const out = [];
  const { rooms } = await api.rooms.list({ page });
  for (const room of rooms || []) {
    try {
      const last = String(room.lastMessage || '').toLowerCase();
      if (!keywords.some((kw) => last.includes(String(kw).toLowerCase()))) continue;
      const msgs = await api.messages.list(room.id, { page: 1 });
      const invite =
        (msgs.messages || []).find((m) => m.projectId) || (msgs.messages || [])[0];
      if (!invite?.projectId) continue;
      let project = null;
      try {
        const got = await api.projects.get(invite.projectId);
        project = got?.project || null;
      } catch {
        project = {
          id: invite.projectId,
          description: invite.text || null,
          raw: { id: invite.projectId },
        };
      }
      const opp = toProjectOpportunity(project || { id: invite.projectId }, {
        source: 'invite',
        now,
      });
      if (opp) {
        if (!opp.description && invite.text) {
          opp.description = String(invite.text).slice(0, 2000);
        }
        out.push(opp);
      }
    } catch (e) {
      logger.warn('invite_room_failed', { roomId: room?.id, err: e.message });
    }
  }
  return out;
}

function stateForDecision(decision, hasMatch) {
  if (decision === 'IGNORE') return 'IGNORED';
  if (
    decision === 'CREATE_DRAFT' ||
    decision === 'REQUEST_APPROVAL' ||
    decision === 'AUTO_EXECUTE'
  ) {
    return 'ACTION_CREATED';
  }
  if (hasMatch) return 'MATCHED';
  return 'ANALYZED';
}

async function applySideEffects({ card, decisionOut, mutations, store, notify, isFresh }) {
  const { opportunity: opp, score, reasons, decision } = card;
  const shouldNotify =
    decision === 'NOTIFY' ||
    decision === 'CREATE_DRAFT' ||
    decision === 'REQUEST_APPROVAL' ||
    decision === 'AUTO_EXECUTE';

  if (shouldNotify && typeof notify === 'function' && (isFresh || decision !== 'NOTIFY')) {
    await notify(formatOpportunityNotify(card), {
      opportunity: opp,
      score,
      decision,
      reasons,
    });
  }

  if (decision === 'CREATE_DRAFT') {
    store.setState(opp.id, 'ACTION_CREATED');
    return;
  }

  if (decision === 'REQUEST_APPROVAL' || decision === 'AUTO_EXECUTE') {
    store.setState(opp.id, 'ACTION_CREATED');
    if (!mutations?.request) return;

    const draftText = [
      '[پیش‌نویس خودکار — ارسال زنده انجام نشده]',
      `پروژه: ${opp.title || opp.id}`,
      `امتیاز: ${score}`,
      'دلایل:',
      ...(reasons || []).slice(0, 6).map((r) => `- ${r}`),
    ].join('\n');

    const price = opp.budgetMin || opp.budgetMax || 1_000_000;
    mutations.request({
      action: 'bids.submit',
      payload: {
        projectId: opp.id,
        proposalText: draftText,
        price,
        days: 7,
        mockAutoExecute: decision === 'AUTO_EXECUTE',
        opportunityScore: score,
      },
      gateCtx: {
        source: 'auto',
        projectId: opp.id,
        matchScore: score,
        confidence: score,
        budget: opp.budgetMax ?? opp.budgetMin,
        category: opp.category,
        hasExistingBid: false,
        riskHint: 'high',
      },
      requestedBy: 'opportunity_scanner',
      targetRef: String(opp.id),
      forceRequireApproval: true,
      idempotencyKey: `opp-bid-draft:${opp.id}`,
    });
    void decisionOut;
  }
}

/**
 * @param {{ opportunity: object, score?: number, reasons?: string[], decision?: string }} card
 */
export function formatOpportunityNotify(card) {
  const o = card.opportunity || {};
  const budget =
    o.budgetMin != null || o.budgetMax != null
      ? `${fmt(o.budgetMin)} – ${fmt(o.budgetMax)}`
      : '—';
  const reasonLines = (card.reasons || []).slice(0, 5).map((r) => `• ${r}`);
  return [
    '🔥 فرصت جدید',
    '————————',
    o.title || `پروژه ${o.id}`,
    `💰 بودجه: ${budget}`,
    `⭐ امتیاز: ${card.score ?? '—'} / ۱۰۰`,
    `📌 تصمیم: ${decisionFa(card.decision)}`,
    o.category ? `📂 دسته: ${o.category}` : null,
    (o.skills || []).length ? `🛠 مهارت‌ها: ${o.skills.slice(0, 5).join('، ')}` : null,
    '',
    'چرا؟',
    ...reasonLines,
  ]
    .filter((line) => line != null)
    .join('\n');
}

function decisionFa(d) {
  switch (d) {
    case 'IGNORE':
      return 'نادیده';
    case 'NOTIFY':
      return 'اطلاع‌رسانی';
    case 'CREATE_DRAFT':
      return 'پیش‌نویس پیشنهاد';
    case 'REQUEST_APPROVAL':
      return 'نیاز به تأیید';
    case 'AUTO_EXECUTE':
      return 'اجرای خودکار (mock → تأیید)';
    default:
      return String(d || '—');
  }
}

function fmt(v) {
  if (v == null) return '—';
  try {
    return Number(v).toLocaleString('fa-IR');
  } catch {
    return String(v);
  }
}

export default createOpportunityScanner;
