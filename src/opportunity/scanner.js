/**
 * Intelligent opportunity scanner.
 * API → normalize → rules → score (+feedback) → decide → notify/draft/limited-auto via PermissionGate.
 * AUTO_EXECUTE never unlimited: approvalPreviewFirstN + daily limits + toggles + emergency.
 */
import { logger } from '../observability/logger.js';
import { toProjectOpportunity } from './normalize.js';
import { createOpportunityStore, ensureOpportunitySchema } from './store.js';
import { matchRules } from './rules-engine.js';
import { scoreOpportunity, isScoringConfigured } from './scoring.js';
import { decideOpportunity } from './decision-engine.js';
import { createFeedbackStore } from './feedback.js';
import { buildSmartBid } from './smart-bid.js';
import {
  createAgentSettingsStore,
  getTodayAutoCounts,
} from '../telegram/agent-settings.js';
import { createPermissionGate } from '../telegram/permission-gate.js';
import { getVerifiedMutation } from '../api/contracts/verified-mutation.js';
import { formatOpportunityNotify } from './format-notify.js';

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<import('../api/adapters/index.js').createKarlancerApi>} deps.api
 * @param {{ request: Function }} [deps.mutations]
 * @param {string} [deps.tenantId]
 * @param {(text: string, meta?: object) => Promise<void>|void} [deps.notify]
 */
export function createOpportunityScanner(deps) {
  const {
    db,
    api,
    mutations = null,
    tenantId = 'default',
    notify = null,
    allowLiveAutoBid = false,
  } = deps;

  ensureOpportunitySchema(db);
  const store = createOpportunityStore(db, { tenantId });
  const settingsStore = createAgentSettingsStore(db, { tenantId });
  const gate = createPermissionGate(db, { tenantId });
  const feedback = createFeedbackStore(db, { tenantId });

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
    if (settings.emergencyStop && !opts.manual && scanState.paused) {
      return { ok: true, skipped: true, reason: 'emergency_paused', scannedAt: nowIso };
    }
    if (
      !opts.manual &&
      scanState.cooldownUntil &&
      Date.parse(scanState.cooldownUntil) > Date.now()
    ) {
      return { ok: true, skipped: true, reason: 'cooldown', scannedAt: nowIso };
    }

    syncScoringAvailable();

    // Lighter scan: default 1 page; use since-last-id cursor to skip already-seen ids early
    const pages = Math.min(5, Math.max(1, Number(opts.pages) || 1));
    const includeInvites = opts.includeInvites !== false;
    const profile = store.getScoringProfile();
    const rules = store.listRules({ enabledOnly: true });
    const todayCounts = getTodayAutoCounts(db, { tenantId });
    const previousIds = new Set(scanState.lastProjectIds || []);
    const sinceId = scanState.sinceLastId || null;

    /** @type {object[]} */
    const fetched = [];
    const errors = [];
    let highestIdSeen = sinceId != null ? Number(sinceId) : null;

    for (let page = 1; page <= pages; page += 1) {
      try {
        const searchParams = { page, ...(opts.searchParams || {}) };
        // Cursor hint when API accepts it (harmless if ignored)
        if (sinceId && !opts.searchParams?.since_id && !opts.manual) {
          searchParams.since_id = sinceId;
        }
        const res = await api.projects.search(searchParams);
        let pageAllSeen = true;
        for (const p of res.projects || []) {
          const opp = toProjectOpportunity(p, { source: 'search', now });
          if (!opp) continue;
          const nid = Number(opp.id);
          if (Number.isFinite(nid)) {
            if (highestIdSeen == null || nid > highestIdSeen) highestIdSeen = nid;
          }
          if (!opts.manual && previousIds.has(opp.id) && sinceId) {
            // already processed in prior light scan — still track but skip heavy re-fetch path later
            continue;
          }
          pageAllSeen = false;
          fetched.push(opp);
        }
        // Stop early when a full page is already known (pagination caught up)
        if (!opts.manual && pageAllSeen && (res.projects || []).length > 0 && page > 1) {
          break;
        }
      } catch (e) {
        errors.push({ source: 'search', page, err: e.message });
        logger.warn('opportunity_search_failed', { page, err: e.message });
      }
    }

    if (includeInvites) {
      try {
        const invites = await fetchInviteOpportunities(api, { now });
        fetched.push(...invites);
      } catch (e) {
        // Soft-fail: never abort search path
        errors.push({ source: 'invites', err: e.message, soft: true });
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
      autoExecuted: 0,
      autoMock: 0,
      decisions: [],
      errors,
      scannedAt: nowIso,
      sinceLastId: sinceId,
    };

    for (const opp of unique) {
      const upsert = store.upsertOpportunity(opp, { state: 'NEW' });
      const isFresh = upsert.isNew || !previousIds.has(opp.id);
      if (upsert.isNew) results.newCount += 1;
      if (upsert.state === 'SUBMITTED') continue;

      const alreadyActed = store.hasSubmittedOrAction(opp.id);
      const rawScored = scoreOpportunity(opp, profile);
      const { matched } = matchRules(opp, rules);
      const scored = feedback.applyBias(rawScored, opp, matched);

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
        const side = await applySideEffects({
          card,
          decisionOut,
          mutations,
          store,
          notify,
          isFresh,
          settings,
          profile,
          todayCounts,
          allowLiveAutoBid,
        });
        if (decisionOut.decision === 'NOTIFY') results.notified += 1;
        if (decisionOut.decision === 'CREATE_DRAFT') results.drafts += 1;
        if (decisionOut.decision === 'REQUEST_APPROVAL') results.approvals += 1;
        if (decisionOut.decision === 'AUTO_EXECUTE') {
          if (side?.autoExecuted) results.autoExecuted += 1;
          else results.autoMock += 1;
        }
      } catch (e) {
        errors.push({ source: 'side_effect', projectId: opp.id, err: e.message });
        logger.warn('opportunity_side_effect_failed', {
          projectId: opp.id,
          err: e.message,
        });
      }
    }

    const mergedIds = [
      ...unique.map((u) => u.id),
      ...(scanState.lastProjectIds || []),
    ];
    const dedupIds = [...new Set(mergedIds)].slice(0, 300);

    store.setScanState({
      lastScanAt: nowIso,
      lastProjectIds: dedupIds,
      sinceLastId:
        highestIdSeen != null && Number.isFinite(highestIdSeen)
          ? String(highestIdSeen)
          : sinceId,
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    });

    logger.info('opportunity_scan_done', {
      scanned: results.scanned,
      newCount: results.newCount,
      matched: results.matched,
      drafts: results.drafts,
      autoExecuted: results.autoExecuted,
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
    feedback,
  };
}

/**
 * Invites path — soft-fail; uses existing auth adapters only (rooms + messages + projects.get).
 * No guessed invite-list endpoints.
 */
async function fetchInviteOpportunities(
  api,
  { now, page = 1, keywords = ['دعوت', 'همکاری', 'پروژه', 'invite'] } = {}
) {
  if (!api?.client?.hasAuth) {
    logger.info('opportunity_invites_skip', { reason: 'no_auth' });
    return [];
  }
  if (!api.rooms?.list || !api.messages?.list) {
    logger.info('opportunity_invites_skip', { reason: 'adapters_missing' });
    return [];
  }

  const out = [];
  let rooms = [];
  try {
    const listed = await api.rooms.list({ page });
    rooms = listed.rooms || [];
  } catch (e) {
    logger.warn('opportunity_invites_rooms_failed', { err: e.message });
    return [];
  }

  for (const room of rooms) {
    try {
      const last = String(room.lastMessage || room.last_message || '').toLowerCase();
      const guest = String(room.guestName || room.guest_name || '').toLowerCase();
      const hay = `${last} ${guest}`;
      if (!keywords.some((kw) => hay.includes(String(kw).toLowerCase()))) continue;

      let msgs = { messages: [] };
      try {
        msgs = await api.messages.list(room.id, { page: 1 });
      } catch (e) {
        logger.warn('invite_messages_failed', { roomId: room?.id, err: e.message });
        continue;
      }

      const invite =
        (msgs.messages || []).find((m) => m.projectId) ||
        (msgs.messages || []).find((m) => /دعوت|invite|همکاری/i.test(String(m.text || '')));
      if (!invite?.projectId && !invite?.text) continue;

      let project = null;
      if (invite?.projectId && api.projects?.get) {
        try {
          const got = await api.projects.get(invite.projectId);
          project = got?.project || null;
        } catch (e) {
          // Soft: build minimal opportunity from message text
          logger.warn('invite_project_get_failed', {
            projectId: invite.projectId,
            err: e.message,
          });
          project = {
            id: invite.projectId,
            description: invite.text || null,
            title: guest ? `دعوت از ${guest}` : null,
            raw: { id: invite.projectId },
          };
        }
      } else if (invite?.projectId) {
        project = {
          id: invite.projectId,
          description: invite.text || null,
          raw: { id: invite.projectId },
        };
      } else {
        continue;
      }

      const opp = toProjectOpportunity(project || { id: invite.projectId }, {
        source: 'invite',
        now,
      });
      if (opp) {
        if (!opp.description && invite.text) {
          opp.description = String(invite.text).slice(0, 2000);
        }
        if (!opp.title && guest) {
          opp.title = `دعوت — ${String(room.guestName || room.guest_name).slice(0, 40)}`;
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

async function applySideEffects({
  card,
  decisionOut,
  mutations,
  store,
  notify,
  isFresh,
  settings,
  profile,
  todayCounts,
  allowLiveAutoBid = false,
}) {
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
    return { drafted: true };
  }

  if (decision === 'REQUEST_APPROVAL' || decision === 'AUTO_EXECUTE') {
    store.setState(opp.id, 'ACTION_CREATED');
    if (!mutations?.request) return { enqueued: false };

    const smart = buildSmartBid(opp, profile, { score, reasons });
    const price = smart.price ?? opp.budgetMin ?? opp.budgetMax ?? 1_000_000;
    const days = smart.days ?? 7;

    // Limited real AUTO_EXECUTE: first N of the day still force HITL preview.
    // Never unlimited — gate + toggles + daily limits already enforced in decideOpportunity.
    // ALLOW_LIVE_AUTO_BID default false → dry-run / approval cards only (no live POST via auto).
    const previewN = settings?.approvalPreviewFirstN ?? 3;
    const autoSoFar = (todayCounts?.bids || 0) + (todayCounts?.messages || 0);
    const liveAllowed = allowLiveAutoBid === true;
    const contract = getVerifiedMutation('bids.submit');
    const contractMissing = !contract;

    const forceRequireApproval =
      decision === 'REQUEST_APPROVAL' ||
      decisionOut.mockAutoExecute === true ||
      autoSoFar < previewN ||
      Boolean(settings?.emergencyStop) ||
      !liveAllowed ||
      contractMissing;

    let result;
    try {
      result = mutations.request({
        action: 'bids.submit',
        payload: {
          projectId: opp.id,
          proposalText: smart.text,
          price,
          days,
          mockAutoExecute: decision === 'AUTO_EXECUTE' && forceRequireApproval,
          limitedAutoExecute: decision === 'AUTO_EXECUTE' && !forceRequireApproval && liveAllowed,
          dryRun: !liveAllowed,
          contractMissing,
          opportunityScore: score,
          smartBid: true,
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
        forceRequireApproval,
        idempotencyKey: `opp-bid:${opp.id}:${decision}`,
      });
    } catch (e) {
      // Soft-fail if contract/mutation path throws
      logger.warn('opportunity_auto_bid_soft_fail', {
        projectId: opp.id,
        err: e?.message || String(e),
        contractMissing,
      });
      return {
        enqueued: false,
        softFail: true,
        contractMissing,
        forceRequireApproval: true,
      };
    }

    void decisionOut;
    return {
      enqueued: true,
      autoExecuted: Boolean(result?.autoExecuted) && liveAllowed && !contractMissing,
      pendingApproval: Boolean(result?.pendingApproval) || forceRequireApproval,
      forceRequireApproval,
      dryRun: !liveAllowed,
      contractMissing,
    };
  }
  return {};
}

export { formatOpportunityNotify };

export default createOpportunityScanner;
