/**
 * PermissionGate — mode + toggles + rules + limits + emergency BEFORE VerifiedMutationContract.
 * Never bypasses contracts; only decides require_approval vs auto_allow vs deny.
 */
import {
  createAgentSettingsStore,
  appendAutomationAudit,
  getTodayAutoCounts,
  listAutomationAudit,
} from './agent-settings.js';

/** Actions gated for Telegram/worker mutation path */
export const GATED_ACTIONS = Object.freeze([
  'messages.send',
  'bids.submit',
  'notifications.mark_read',
  'messages.mark_seen',
]);

const LOW_RISK = new Set(['notifications.mark_read', 'messages.mark_seen']);
const HIGH_RISK = new Set(['messages.send', 'bids.submit']);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ tenantId?: string }} [opts]
 */
export function createPermissionGate(db, { tenantId = 'default' } = {}) {
  const settings = createAgentSettingsStore(db, { tenantId });

  /**
   * Evaluate whether a mutation may proceed automatically or needs HITL.
   *
   * @param {string} action
   * @param {object} [ctx]
   * @param {string} [ctx.source] 'owner_confirm' | 'auto' | 'system' | 'telegram'
   * @param {string|number} [ctx.roomId]
   * @param {string|number} [ctx.userId]
   * @param {string} [ctx.text]
   * @param {string|number} [ctx.projectId]
   * @param {number} [ctx.matchScore]
   * @param {number} [ctx.confidence]
   * @param {number} [ctx.budget]
   * @param {string} [ctx.category]
   * @param {boolean} [ctx.hasExistingBid]
   * @param {string} [ctx.clientStatus]
   * @param {'low'|'medium'|'high'} [ctx.riskHint]
   * @returns {{
   *   decision: 'deny'|'require_approval'|'auto_allow',
   *   reason: string,
   *   reasonFa: string,
   *   risk: 'low'|'medium'|'high',
   *   mode: string,
   *   showCard: boolean,
   *   settings: object,
   *   matchedRule: string|null,
   * }}
   */
  function check(action, ctx = {}) {
    const s = settings.get();
    const risk = deriveRisk(action, ctx);
    const base = {
      mode: s.mode,
      risk,
      settings: s,
      matchedRule: null,
      showCard: false,
    };

    if (!GATED_ACTIONS.includes(action)) {
      return {
        ...base,
        decision: 'require_approval',
        reason: 'unknown_action',
        reasonFa: 'عملیات ناشناخته — نیاز به تأیید',
      };
    }

    // Blacklist always wins
    const bl = checkBlacklist(s, ctx);
    if (bl) {
      return {
        ...base,
        decision: 'deny',
        reason: bl.reason,
        reasonFa: bl.reasonFa,
      };
    }

    // Owner already confirmed in Telegram preview → allow (emergency only freezes *auto*)
    if (ctx.source === 'owner_confirm') {
      return {
        ...base,
        decision: 'auto_allow',
        reason: s.emergencyStop ? 'owner_confirm_during_emergency' : 'owner_confirm',
        reasonFa: s.emergencyStop
          ? 'تأیید دستی مالک (خودکار متوقف است)'
          : 'تأیید مالک',
        showCard: false,
      };
    }

    if (s.emergencyStop) {
      return {
        ...base,
        decision: 'require_approval',
        reason: 'emergency_stop',
        reasonFa: 'توقف اضطراری — همهٔ ارسال‌های خودکار خاموش است',
        showCard: true,
      };
    }

    // Manual: every mutation needs approval
    if (s.mode === 'manual') {
      return {
        ...base,
        decision: 'require_approval',
        reason: 'manual_mode',
        reasonFa: 'حالت دستی — هر عملیات نیاز به تأیید دارد',
        showCard: true,
      };
    }

    // Assisted: low-risk may auto; send/bid always approval
    if (s.mode === 'assisted') {
      if (HIGH_RISK.has(action)) {
        return {
          ...base,
          decision: 'require_approval',
          reason: 'assisted_high_risk',
          reasonFa: 'حالت کمکی — ارسال/پیشنهاد نیاز به تأیید دارد',
          showCard: true,
        };
      }
      if (LOW_RISK.has(action)) {
        if (!s.toggles.autoMarkNotificationsRead) {
          return {
            ...base,
            decision: 'require_approval',
            reason: 'toggle_off_mark_read',
            reasonFa: 'خواندن اعلان خودکار خاموش است',
            showCard: true,
          };
        }
        return {
          ...base,
          decision: 'auto_allow',
          reason: 'assisted_low_risk',
          reasonFa: 'حالت کمکی — عملیات کم‌ریسک مجاز',
          showCard: false,
        };
      }
      return {
        ...base,
        decision: 'require_approval',
        reason: 'assisted_default',
        reasonFa: 'حالت کمکی — نیاز به تأیید',
        showCard: true,
      };
    }

    // Auto mode — never unlimited; toggles + rules + limits
    if (s.mode === 'auto') {
      return checkAutoMode(s, action, ctx, base);
    }

    return {
      ...base,
      decision: 'require_approval',
      reason: 'fallback',
      reasonFa: 'نیاز به تأیید',
      showCard: true,
    };
  }

  function checkAutoMode(s, action, ctx, base) {
    if (action === 'messages.send') {
      if (!s.toggles.autoReplyMessages) {
        return {
          ...base,
          decision: 'require_approval',
          reason: 'toggle_off_auto_reply',
          reasonFa: 'پاسخ خودکار خاموش است',
          showCard: true,
        };
      }
      const rule = matchMessageRule(s.rules.messageAuto, ctx);
      if (!rule.ok) {
        return {
          ...base,
          decision: 'require_approval',
          reason: rule.reason,
          reasonFa: rule.reasonFa,
          showCard: true,
        };
      }
      const counts = getTodayAutoCounts(db, { tenantId });
      if (counts.messages >= s.limits.maxAutoMessagesPerDay) {
        return {
          ...base,
          decision: 'require_approval',
          reason: 'daily_limit_messages',
          reasonFa: `سقف روزانه پیام خودکار (${s.limits.maxAutoMessagesPerDay}) پر شده`,
          showCard: true,
        };
      }
      // First N auto-eligible messages each (Tehran) day get a preview card;
      // after that rule+limits are enough. Counts previews shown, not owner sends.
      const showCard = (counts.previews || 0) < (s.approvalPreviewFirstN || 0);
      return {
        ...base,
        decision: showCard ? 'require_approval' : 'auto_allow',
        reason: showCard ? 'auto_preview_card' : 'auto_rule_matched',
        reasonFa: showCard
          ? 'اجرای خودکار با پیش‌نمایش برای اطمینان'
          : 'قانون خودکار پیام تطبیق یافت',
        showCard,
        matchedRule: 'messageAuto',
      };
    }

    if (action === 'bids.submit') {
      if (!s.toggles.autoSubmitBids) {
        return {
          ...base,
          decision: 'require_approval',
          reason: 'toggle_off_auto_bid',
          reasonFa: 'ثبت پیشنهاد خودکار خاموش است',
          showCard: true,
        };
      }
      const rule = matchBidRule(s.rules.bidAuto, ctx);
      if (!rule.ok) {
        return {
          ...base,
          decision: 'require_approval',
          reason: rule.reason,
          reasonFa: rule.reasonFa,
          showCard: true,
        };
      }
      const counts = getTodayAutoCounts(db, { tenantId });
      if (counts.bids >= s.limits.maxAutoBidsPerDay) {
        return {
          ...base,
          decision: 'require_approval',
          reason: 'daily_limit_bids',
          reasonFa: `سقف روزانه پیشنهاد خودکار (${s.limits.maxAutoBidsPerDay}) پر شده`,
          showCard: true,
        };
      }
      const show = (counts.previews || 0) < (s.approvalPreviewFirstN || 0);
      return {
        ...base,
        decision: show ? 'require_approval' : 'auto_allow',
        reason: show ? 'auto_preview_card' : 'auto_rule_matched',
        reasonFa: show
          ? 'اجرای خودکار با پیش‌نمایش برای اطمینان'
          : 'قانون خودکار پیشنهاد تطبیق یافت',
        showCard: show,
        matchedRule: 'bidAuto',
      };
    }

    if (LOW_RISK.has(action)) {
      if (!s.toggles.autoMarkNotificationsRead) {
        return {
          ...base,
          decision: 'require_approval',
          reason: 'toggle_off_mark_read',
          reasonFa: 'خواندن اعلان خودکار خاموش است',
          showCard: true,
        };
      }
      return {
        ...base,
        decision: 'auto_allow',
        reason: 'auto_low_risk',
        reasonFa: 'عملیات کم‌ریسک در حالت خودکار',
        showCard: false,
      };
    }

    return {
      ...base,
      decision: 'require_approval',
      reason: 'auto_default',
      reasonFa: 'نیاز به تأیید',
      showCard: true,
    };
  }

  function recordDecision(action, gateResult, extra = {}) {
    const isAuto =
      !String(gateResult.reason || '').startsWith('owner_confirm') &&
      (gateResult.decision === 'auto_allow' || gateResult.reason?.startsWith('auto_'));
    const ownerConfirmed =
      gateResult.reason === 'owner_confirm' || gateResult.reason === 'owner_confirm_during_emergency';
    const auditAction = ownerConfirmed
      ? `owner.${action}`
      : gateResult.decision === 'auto_allow'
        ? `auto.${action}`
        : gateResult.decision === 'deny'
          ? `deny.${action}`
          : `gate.${action}`;
    return appendAutomationAudit(db, {
      tenantId,
      actor: extra.actor || 'permission_gate',
      action: auditAction,
      resultCode: gateResult.decision,
      correlationId: extra.correlationId || null,
      detail: {
        action,
        reason: gateResult.reason,
        reasonFa: gateResult.reasonFa,
        mode: gateResult.mode,
        risk: gateResult.risk,
        matchedRule: gateResult.matchedRule,
        approved_by: extra.approvedBy || (gateResult.decision === 'auto_allow' ? 'auto' : null),
        roomId: extra.roomId ?? null,
        projectId: extra.projectId ?? null,
        isAuto,
        ...extra.detail,
      },
    });
  }

  return {
    settings,
    check,
    recordDecision,
    getTodayAutoCounts: () => getTodayAutoCounts(db, { tenantId }),
    listAudit: (opts) => listAutomationAudit(db, { tenantId, ...opts }),
    emergencyStop: () => {
      const s = settings.emergencyStop();
      appendAutomationAudit(db, {
        tenantId,
        actor: 'owner',
        action: 'emergency_stop',
        resultCode: 'ok',
        detail: { mode: s.mode, toggles: s.toggles },
      });
      return s;
    },
    clearEmergency: (opts) => settings.clearEmergency(opts),
  };
}

function deriveRisk(action, ctx) {
  if (ctx.riskHint === 'high' || ctx.riskHint === 'medium' || ctx.riskHint === 'low') {
    return ctx.riskHint;
  }
  if (HIGH_RISK.has(action)) return 'high';
  if (LOW_RISK.has(action)) return 'low';
  return 'medium';
}

function checkBlacklist(s, ctx) {
  const roomId = ctx.roomId != null ? String(ctx.roomId) : null;
  const userId = ctx.userId != null ? String(ctx.userId) : null;
  const text = String(ctx.text || '').toLowerCase();
  if (roomId && s.blacklist.rooms.map(String).includes(roomId)) {
    return { reason: 'blacklist_room', reasonFa: 'این گفتگو در لیست سیاه است' };
  }
  if (userId && s.blacklist.users.map(String).includes(userId)) {
    return { reason: 'blacklist_user', reasonFa: 'این کاربر در لیست سیاه است' };
  }
  for (const kw of s.blacklist.keywords) {
    if (kw && text.includes(String(kw).toLowerCase())) {
      return { reason: 'blacklist_keyword', reasonFa: 'کلیدواژهٔ ممنوع در متن' };
    }
  }
  return null;
}

/** Implicit criterion when the owner enabled the message rule without setting any: AI confidence ≥ 60. */
export const DEFAULT_MESSAGE_SCORE_THRESHOLD = 60;

function matchMessageRule(rule, ctx) {
  if (!rule?.enabled) {
    return {
      ok: false,
      reason: 'rule_message_disabled',
      reasonFa: 'قانون پیام خودکار خاموش است',
    };
  }
  const explicit =
    rule.matchScoreThreshold != null ||
    (rule.keywords && rule.keywords.length > 0) ||
    rule.budgetMin != null ||
    Boolean(rule.clientStatus);
  // Chat score = AI confidence × 100 (computed per reply) — no separate scoring profile needed.
  const threshold =
    rule.matchScoreThreshold != null
      ? Number(rule.matchScoreThreshold)
      : explicit
        ? null
        : DEFAULT_MESSAGE_SCORE_THRESHOLD;
  if (threshold != null) {
    if (ctx.matchScore == null || !Number.isFinite(Number(ctx.matchScore))) {
      return {
        ok: false,
        reason: 'score_unavailable',
        reasonFa: 'امتیاز اطمینان این پاسخ در دسترس نیست',
      };
    }
    if (Number(ctx.matchScore) < threshold) {
      return {
        ok: false,
        reason: 'score_below_threshold',
        reasonFa: 'امتیاز اطمینان زیر آستانهٔ قانون',
      };
    }
  }
  if (rule.keywords?.length) {
    const text = String(ctx.clientText || ctx.text || '').toLowerCase();
    const hit = rule.keywords.some((kw) => text.includes(String(kw).toLowerCase()));
    if (!hit) {
      return {
        ok: false,
        reason: 'keyword_mismatch',
        reasonFa: 'کلیدواژهٔ قانون در پیام کارفرما نبود',
      };
    }
  }
  if (rule.budgetMin != null && ctx.budget != null && Number(ctx.budget) < Number(rule.budgetMin)) {
    return {
      ok: false,
      reason: 'budget_below_min',
      reasonFa: 'بودجه زیر حداقل قانون',
    };
  }
  if (rule.clientStatus && ctx.clientStatus && String(ctx.clientStatus) !== String(rule.clientStatus)) {
    return {
      ok: false,
      reason: 'client_status_mismatch',
      reasonFa: 'وضعیت کارفرما با قانون یکی نیست',
    };
  }
  return { ok: true };
}

function matchBidRule(rule, ctx) {
  if (!rule?.enabled) {
    return {
      ok: false,
      reason: 'rule_bid_disabled',
      reasonFa: 'قانون پیشنهاد خودکار خاموش است',
    };
  }
  if (!rule.scoringAvailable && rule.confidenceThreshold != null) {
    return {
      ok: false,
      reason: 'scoring_unavailable',
      reasonFa: 'امتیازدهی هنوز فعال نیست — قانون خاموش می‌ماند',
    };
  }
  if (rule.noExistingBid && ctx.hasExistingBid === true) {
    return {
      ok: false,
      reason: 'existing_bid',
      reasonFa: 'قبلاً پیشنهاد ثبت شده',
    };
  }
  if (rule.categoryMatch?.length) {
    const cat = String(ctx.category || '');
    if (!rule.categoryMatch.map(String).includes(cat)) {
      return {
        ok: false,
        reason: 'category_mismatch',
        reasonFa: 'دسته با قانون یکی نیست',
      };
    }
  }
  if (
    rule.budgetThreshold != null &&
    ctx.budget != null &&
    Number(ctx.budget) < Number(rule.budgetThreshold)
  ) {
    return {
      ok: false,
      reason: 'budget_below_threshold',
      reasonFa: 'بودجه زیر آستانهٔ قانون',
    };
  }
  if (
    rule.confidenceThreshold != null &&
    (ctx.confidence == null || Number(ctx.confidence) < Number(rule.confidenceThreshold))
  ) {
    return {
      ok: false,
      reason: 'confidence_below_threshold',
      reasonFa: 'اطمینان زیر آستانهٔ قانون',
    };
  }
  const hasCriterion =
    (rule.categoryMatch && rule.categoryMatch.length > 0) ||
    rule.budgetThreshold != null ||
    rule.confidenceThreshold != null;
  if (!hasCriterion) {
    return {
      ok: false,
      reason: 'rule_not_configured',
      reasonFa: 'قانون پیشنهاد هنوز پیکربندی نشده',
    };
  }
  return { ok: true };
}


export default createPermissionGate;
