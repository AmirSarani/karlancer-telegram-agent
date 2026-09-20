/**
 * Job goal handlers — deterministic where possible; mutations require prior approval.
 */
import { logger } from '../observability/logger.js';
import { memoryAppend } from '../memory/store.js';

/**
 * @param {object} ctx
 * @param {ReturnType<import('../api/adapters/index.js').createKarlancerApi>} ctx.api
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {ReturnType<import('./queue.js').createJobQueue>} ctx.queue
 */
export async function handleJob(ctx, job) {
  const { api, db } = ctx;
  const goal = job.goal;
  const p = job.payload || {};

  switch (goal) {
    case 'rooms.scan': {
      if (!api.client.hasAuth) {
        return { ok: false, errorCode: 'missing_auth', detail: 'KARLANCER_ACCESS_TOKEN required' };
      }
      const page = p.page || 1;
      const keywords = p.keywords || ['دعوت', 'همکاری', 'پروژه'];
      const { rooms } = await api.rooms.list({ page });
      const matched = [];
      for (const room of rooms.filter(Boolean)) {
        const last = (room.lastMessage || '').toLowerCase();
        if (!keywords.some((kw) => last.includes(String(kw).toLowerCase()))) continue;
        const msgs = await api.messages.list(room.id, { page: 1 });
        const invite = msgs.messages.find((m) => m.projectId) || msgs.messages[0];
        if (!invite?.projectId) continue;
        const bid = await api.bids.check([invite.projectId]);
        if (bid.weBidFor(invite.projectId)) continue;
        const project = await api.projects.get(invite.projectId);
        matched.push({
          roomId: room.id,
          projectId: invite.projectId,
          inviteText: invite.text,
          project: project.project,
        });
        memoryAppend(db, {
          kind: 'invite_seen',
          refId: room.id,
          content: invite.text || project.project?.title || room.id,
          meta: { projectId: invite.projectId },
        });
      }
      return { ok: true, result: { page, matchedCount: matched.length, matched } };
    }

    case 'project.get': {
      const project = await api.projects.get(p.projectId, { slug: p.slug });
      return { ok: true, result: project };
    }

    case 'messages.list': {
      const data = await api.messages.list(p.roomId, { page: p.page || 1 });
      return { ok: true, result: { roomId: data.roomId, page: data.page, count: data.messages.length, messages: data.messages } };
    }

    case 'bids.check': {
      const data = await api.bids.check(p.projectIds || p.projectId);
      return { ok: true, result: data };
    }

    case 'bids.submit': {
      // Approval already gated by queue status transition
      const data = await api.bids.submit({
        projectId: p.projectId,
        proposalText: p.proposalText,
        price: p.price,
        days: p.days,
      });
      if (!data.ok) {
        // Unknown / blocked — reconcile via check-bid rather than blind retry
        ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
          errorCode: data.status || 'blocked_by_missing_api',
          result: data,
        });
        return { ok: false, errorCode: 'needs_reconciliation', detail: data, terminal: true };
      }
      // Verify
      try {
        const check = await api.bids.check([p.projectId]);
        if (!check.weBidFor(p.projectId)) {
          ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
            errorCode: 'bid_not_visible_yet',
            result: { submit: data, check },
          });
          return { ok: false, errorCode: 'needs_reconciliation', detail: { submit: data, check }, terminal: true };
        }
      } catch (e) {
        logger.warn('bid_reconcile_check_failed', { err: e.message });
      }
      return { ok: true, result: data };
    }

    case 'messages.send': {
      const data = await api.messages.send(p.roomId, p.text);
      if (!data.ok) {
        ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
          errorCode: data.status || 'blocked_by_missing_api',
          result: data,
        });
        return { ok: false, errorCode: 'needs_reconciliation', detail: data, terminal: true };
      }
      return { ok: true, result: data };
    }

    case 'health.ping': {
      return { ok: true, result: { pong: true, ts: new Date().toISOString() } };
    }

    default:
      return { ok: false, errorCode: 'unknown_goal', detail: { goal } };
  }
}
