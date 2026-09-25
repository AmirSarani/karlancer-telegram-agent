/**
 * Enqueue mutations only after PermissionGate — never bypasses VerifiedMutationContract.
 * Auto path: create approval job then decideApproval(approved_by=auto:…) so worker revalidation passes.
 */
import crypto from 'node:crypto';

/**
 * @param {object} deps
 * @param {ReturnType<import('../worker/queue.js').createJobQueue>} deps.queue
 * @param {ReturnType<import('./permission-gate.js').createPermissionGate>} deps.gate
 */
export function createMutationRequester({ queue, gate }) {
  if (!queue || !gate) {
    throw new Error('mutation_requester_requires_queue_and_gate');
  }

  /**
   * @param {object} input
   * @param {string} input.action — messages.send | bids.submit | notifications.mark_read | …
   * @param {object} input.payload
   * @param {object} [input.gateCtx] — context for PermissionGate.check
   * @param {string} [input.requestedBy]
   * @param {string} [input.targetRef]
   * @param {string} [input.operationId]
   * @param {string} [input.idempotencyKey]
   * @param {boolean} [input.forceRequireApproval] — always HITL even if gate would auto
   */
  function request(input) {
    const {
      action,
      payload = {},
      gateCtx = {},
      requestedBy = 'system',
      targetRef = null,
      operationId = null,
      idempotencyKey = null,
      forceRequireApproval = false,
    } = input;

    const verdict = gate.check(action, gateCtx);
    const isOwnerConfirm = gateCtx.source === 'owner_confirm';

    // Forced HITL (scan-prepare, follow-up drafts) must not count as an automatic send.
    const recorded =
      forceRequireApproval && !isOwnerConfirm && verdict.decision === 'auto_allow'
        ? { ...verdict, decision: 'require_approval', reason: 'forced_approval', reasonFa: 'نیاز به تأیید شما' }
        : verdict;
    gate.recordDecision(action, recorded, {
      actor: requestedBy,
      approvedBy: isOwnerConfirm
        ? requestedBy
        : recorded.decision === 'auto_allow'
          ? 'auto:permission_gate'
          : null,
      roomId: payload.roomId ?? gateCtx.roomId,
      projectId: payload.projectId ?? gateCtx.projectId,
      correlationId: operationId || null,
    });

    if (verdict.decision === 'deny') {
      return {
        ok: false,
        denied: true,
        verdict,
        job: null,
        approval: null,
      };
    }

    // Always create with requiresApproval so payload_hash / approval row exists for worker revalidation.
    const job = queue.create({
      goal: action,
      requiresApproval: true,
      payload,
      requestedBy,
      targetRef,
      operationId: operationId || crypto.randomUUID(),
      idempotencyKey,
    });

    const approval = queue.getApprovalForJob(job.jobId);
    if (!approval) {
      return {
        ok: false,
        denied: false,
        error: 'missing_approval_row',
        verdict,
        job,
        approval: null,
      };
    }

    // Owner already confirmed in Telegram preview → approve immediately as owner
    if (isOwnerConfirm && verdict.decision === 'auto_allow') {
      const decided = queue.decideApproval(approval.approval_id, {
        approve: true,
        decidedBy: requestedBy,
      });
      return {
        ok: true,
        autoExecuted: false,
        ownerConfirmed: true,
        verdict,
        job: decided?.job || queue.get(job.jobId),
        approval: decided?.approval || queue.getApproval(approval.approval_id),
        decided,
      };
    }

    const needsApproval =
      forceRequireApproval ||
      verdict.decision === 'require_approval' ||
      Boolean(verdict.showCard);

    // True auto (rules+toggles+limits) — approve as auto actor
    if (!needsApproval && verdict.decision === 'auto_allow') {
      const decided = queue.decideApproval(approval.approval_id, {
        approve: true,
        decidedBy: `auto:permission_gate:${verdict.reason}`,
      });
      return {
        ok: true,
        autoExecuted: true,
        verdict,
        job: decided?.job || queue.get(job.jobId),
        approval: decided?.approval || queue.getApproval(approval.approval_id),
        decided,
      };
    }

    return {
      ok: true,
      autoExecuted: false,
      pendingApproval: true,
      verdict,
      job,
      approval,
    };
  }

  return { request };
}

export default createMutationRequester;

/**
 * Convenience: gate + enqueue notifications.mark_read (still VerifiedMutationContract in worker/adapter).
 */
export function requestMarkNotificationsRead(mutations, { notificationIds, requestedBy = 'system', gateCtx = {} } = {}) {
  const ids = (Array.isArray(notificationIds) ? notificationIds : [notificationIds]).filter(Boolean).map(String);
  return mutations.request({
    action: 'notifications.mark_read',
    payload: { notifications: ids },
    gateCtx: { ...gateCtx, riskHint: gateCtx.riskHint || 'low' },
    requestedBy,
    targetRef: ids[0] || null,
    operationId: `notif-read:${ids.slice(0, 5).join(',')}:${Date.now()}`,
  });
}
