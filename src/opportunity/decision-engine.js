/**
 * Decision engine — combines score + matched rules + execution mode + safety limits.
 * Score ≠ permission. AUTO_EXECUTE never bypasses PermissionGate / mutation-request.
 */

import { ruleActionToDecision } from './rules-engine.js';

/**
 * @typedef {'IGNORE'|'NOTIFY'|'CREATE_DRAFT'|'REQUEST_APPROVAL'|'AUTO_EXECUTE'} OppDecision
 */

/**
 * @param {object} input
 * @param {object} input.opportunity
 * @param {number} input.score
 * @param {string[]} input.reasons
 * @param {object[]} input.matchedRules — from matchRules().matched
 * @param {object} input.settings — agent settings (mode, toggles, limits, emergencyStop)
 * @param {object} [input.gate] — PermissionGate instance (optional; used for AUTO_EXECUTE preview)
 * @param {{ messages?: number, bids?: number }} [input.todayCounts]
 * @param {boolean} [input.alreadyActed] — duplicate bid / prior ACTION_CREATED|SUBMITTED
 * @param {boolean} [input.cooldownActive]
 * @returns {{
 *   decision: OppDecision,
 *   reasons: string[],
 *   matchedRules: object[],
 *   gateVerdict: object|null,
 *   mockAutoExecute: boolean,
 * }}
 */
export function decideOpportunity(input) {
  const {
    opportunity,
    score = 0,
    reasons: scoreReasons = [],
    matchedRules = [],
    settings,
    gate = null,
    todayCounts = {},
    alreadyActed = false,
    cooldownActive = false,
  } = input;

  /** @type {string[]} */
  const reasons = [...scoreReasons];
  const mode = settings?.mode || 'manual';
  const emergency = Boolean(settings?.emergencyStop);
  const primary = matchedRules[0] || null;

  if (alreadyActed) {
    return {
      decision: 'IGNORE',
      reasons: [...reasons, 'قبلاً اقدام/پیشنهاد برای این پروژه ثبت شده'],
      matchedRules,
      gateVerdict: null,
      mockAutoExecute: false,
    };
  }

  if (emergency) {
    return {
      decision: score >= 70 ? 'NOTIFY' : 'IGNORE',
      reasons: [...reasons, 'توقف اضطراری فعال — فقط اطلاع‌رسانی در صورت امتیاز بالا'],
      matchedRules,
      gateVerdict: null,
      mockAutoExecute: false,
    };
  }

  if (cooldownActive) {
    return {
      decision: 'IGNORE',
      reasons: [...reasons, 'کول‌داون اسکن فعال است'],
      matchedRules,
      gateVerdict: null,
      mockAutoExecute: false,
    };
  }

  // No match + low score → ignore
  if (!primary && score < 40) {
    return {
      decision: 'IGNORE',
      reasons: [...reasons, 'قانونی تطبیق نکرد و امتیاز زیر ۴۰ است'],
      matchedRules,
      gateVerdict: null,
      mockAutoExecute: false,
    };
  }

  const ruleDecision = primary ? ruleActionToDecision(primary.action) : null;

  // —— Manual: never silent mutation ——
  if (mode === 'manual') {
    if (ruleDecision === 'IGNORE' || (!primary && score < 55)) {
      return {
        decision: 'IGNORE',
        reasons: [...reasons, 'حالت دستی — نادیده (امتیاز/قانون کافی نیست)'],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }
    if (score >= 70 || ruleDecision === 'CREATE_DRAFT' || ruleDecision === 'REQUEST_APPROVAL') {
      return {
        decision: 'CREATE_DRAFT',
        reasons: [...reasons, 'حالت دستی — پیش‌نویس پیشنهاد برای تأیید شما'],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }
    return {
      decision: 'NOTIFY',
      reasons: [...reasons, 'حالت دستی — فقط اطلاع‌رسانی فرصت'],
      matchedRules,
      gateVerdict: null,
      mockAutoExecute: false,
    };
  }

  // —— Assisted: prepare drafts / notify; high-risk never auto ——
  if (mode === 'assisted') {
    if (ruleDecision === 'IGNORE') {
      return {
        decision: 'IGNORE',
        reasons: [...reasons, 'قانون: نادیده'],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }
    if (score >= 60 || ruleDecision === 'CREATE_DRAFT' || ruleDecision === 'REQUEST_APPROVAL' || ruleDecision === 'AUTO_EXECUTE') {
      return {
        decision: 'CREATE_DRAFT',
        reasons: [...reasons, 'حالت کمکی — پیش‌نویس؛ ارسال نیاز به تأیید دارد'],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }
    if (score >= 40 || primary) {
      return {
        decision: 'NOTIFY',
        reasons: [...reasons, 'حالت کمکی — اطلاع‌رسانی'],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }
    return {
      decision: 'IGNORE',
      reasons: [...reasons, 'حالت کمکی — امتیاز پایین بدون قانون'],
      matchedRules,
      gateVerdict: null,
      mockAutoExecute: false,
    };
  }

  // —— Auto: only if rule matched + toggles + limits + gate ——
  if (mode === 'auto') {
    if (!primary) {
      return {
        decision: score >= 70 ? 'NOTIFY' : score >= 50 ? 'CREATE_DRAFT' : 'IGNORE',
        reasons: [...reasons, 'حالت خودکار بدون قانون تطبیقی — بدون AUTO_EXECUTE'],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }

    if (ruleDecision === 'IGNORE') {
      return {
        decision: 'IGNORE',
        reasons: [...reasons, `قانون «${primary.name}»: نادیده`],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }

    if (ruleDecision === 'NOTIFY') {
      return {
        decision: 'NOTIFY',
        reasons: [...reasons, `قانون «${primary.name}»: اطلاع‌رسانی`],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }

    if (ruleDecision === 'CREATE_DRAFT') {
      return {
        decision: 'CREATE_DRAFT',
        reasons: [...reasons, `قانون «${primary.name}»: پیش‌نویس پیشنهاد`],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }

    if (ruleDecision === 'REQUEST_APPROVAL') {
      return {
        decision: 'REQUEST_APPROVAL',
        reasons: [...reasons, `قانون «${primary.name}»: درخواست تأیید`],
        matchedRules,
        gateVerdict: null,
        mockAutoExecute: false,
      };
    }

    // AUTO_EXECUTE path — still go through gate; mock actual submit
    if (ruleDecision === 'AUTO_EXECUTE') {
      if (!settings?.toggles?.autoSubmitBids) {
        return {
          decision: 'REQUEST_APPROVAL',
          reasons: [...reasons, 'سوئیچ ثبت پیشنهاد خودکار خاموش است → تأیید لازم'],
          matchedRules,
          gateVerdict: null,
          mockAutoExecute: false,
        };
      }
      const maxBids = settings?.limits?.maxAutoBidsPerDay ?? 10;
      if ((todayCounts.bids || 0) >= maxBids) {
        return {
          decision: 'REQUEST_APPROVAL',
          reasons: [...reasons, `سقف روزانه پیشنهاد خودکار (${maxBids}) پر شده`],
          matchedRules,
          gateVerdict: null,
          mockAutoExecute: false,
        };
      }

      let gateVerdict = null;
      if (gate && typeof gate.check === 'function') {
        gateVerdict = gate.check('bids.submit', {
          source: 'auto',
          projectId: opportunity?.id,
          matchScore: score,
          confidence: score,
          budget: opportunity?.budgetMax ?? opportunity?.budgetMin,
          category: opportunity?.category,
          hasExistingBid: alreadyActed,
          riskHint: 'high',
        });
      }

      if (!gateVerdict || gateVerdict.decision === 'deny') {
        return {
          decision: 'IGNORE',
          reasons: [...reasons, `گیت اجازه نداد: ${gateVerdict?.reasonFa || gateVerdict?.reason || 'deny'}`],
          matchedRules,
          gateVerdict,
          mockAutoExecute: false,
        };
      }

      if (gateVerdict.decision === 'require_approval' || gateVerdict.showCard) {
        return {
          decision: 'REQUEST_APPROVAL',
          reasons: [...reasons, `گیت: ${gateVerdict.reasonFa || gateVerdict.reason}`],
          matchedRules,
          gateVerdict,
          mockAutoExecute: false,
        };
      }

      // gate auto_allow — still MOCK: do not live-submit; route as REQUEST_APPROVAL with mock flag
      // (mutation-request may still require approval depending on preview N)
      return {
        decision: 'AUTO_EXECUTE',
        reasons: [
          ...reasons,
          `قانون «${primary.name}» + گیت auto_allow — مسیر mock از PermissionGate/mutation-request`,
        ],
        matchedRules,
        gateVerdict,
        mockAutoExecute: true,
      };
    }
  }

  return {
    decision: 'NOTIFY',
    reasons: [...reasons, 'تصمیم پیش‌فرض: اطلاع‌رسانی'],
    matchedRules,
    gateVerdict: null,
    mockAutoExecute: false,
  };
}

export default decideOpportunity;
