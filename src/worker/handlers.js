/**
 * Job goal handlers — deterministic where possible; mutations require VerifiedMutationContract.
 */
import crypto from 'node:crypto';
import { logger } from '../observability/logger.js';
import { memoryAppend } from '../memory/store.js';
import { bidIdempotencyKey } from '../api/contracts/verified-mutation.js';

/**
 * @param {object} ctx
 * @param {ReturnType<import('../api/adapters/index.js').createKarlancerApi>} ctx.api
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {ReturnType<import('./queue.js').createJobQueue>} ctx.queue
 * @param {ReturnType<import('../llm/provider.js').createLlmProvider>} [ctx.llm]
 * @param {import('../intelligence/token-budget.js').TokenBudgetManager} [ctx.budget]
 * @param {Function} [ctx.onEvent]  projection hook
 */
export async function handleJob(ctx, job) {
  const { api, db, llm, budget } = ctx;
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
        memoryAppend(db, {
          kind: 'room_last_message',
          refId: room.id,
          content: room.lastMessage || '',
          meta: { updatedAt: room.updatedAt },
        });
      }
      await emit(ctx, 'rooms.scanned', { page, matchedCount: matched.length });
      return { ok: true, result: { page, matchedCount: matched.length, matched } };
    }

    case 'project.get': {
      const project = await api.projects.get(p.projectId, { slug: p.slug });
      memoryAppend(db, {
        kind: 'project_viewed',
        refId: String(p.projectId),
        content: project.project?.title || String(p.projectId),
        meta: { slug: project.slug },
      });
      return { ok: true, result: project };
    }

    case 'messages.list': {
      const data = await api.messages.list(p.roomId, { page: p.page || 1 });
      if (data.messages[0]) {
        memoryAppend(db, {
          kind: 'room_last_message',
          refId: String(p.roomId),
          content: data.messages[0].text || '',
          meta: { messageId: data.messages[0].id },
        });
      }
      return {
        ok: true,
        result: {
          roomId: data.roomId,
          page: data.page,
          count: data.messages.length,
          messages: data.messages,
          pagination: data.pagination,
        },
      };
    }

    case 'bids.check': {
      const data = await api.bids.check(p.projectIds || p.projectId);
      return { ok: true, result: data };
    }

    case 'bids.submit': {
      // MUST use VerifiedMutationContract; no try-list. No auto-retry on unknown.
      const operationId =
        job.operationId ||
        p.operationId ||
        bidIdempotencyKey({
          projectId: p.projectId,
          proposalText: p.proposalText,
          price: p.price,
          days: p.days,
        });
      const data = await api.bids.submit({
        projectId: p.projectId,
        proposalText: p.proposalText,
        price: p.price,
        days: p.days,
        operationId,
      });

      if (!data.ok) {
        const code = data.status || 'blocked_by_missing_api';
        // timeout / unknown after POST → needs_reconciliation, NEVER retry POST
        ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
          errorCode: code,
          result: data,
        });
        await emit(ctx, 'bid.blocked', { code, posted: data.posted === true });
        return { ok: false, errorCode: 'needs_reconciliation', detail: data, terminal: true };
      }

      try {
        const check = await api.bids.check([p.projectId]);
        if (!check.weBidFor(p.projectId)) {
          ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
            errorCode: 'bid_not_visible_yet',
            result: { submit: data, check },
          });
          return {
            ok: false,
            errorCode: 'needs_reconciliation',
            detail: { submit: data, check },
            terminal: true,
          };
        }
      } catch (e) {
        logger.warn('bid_reconcile_check_failed', { err: e.message });
        ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
          errorCode: 'reconcile_check_failed',
          result: { submit: data },
        });
        return { ok: false, errorCode: 'needs_reconciliation', detail: { submit: data }, terminal: true };
      }
      await emit(ctx, 'bid.submitted', { projectId: p.projectId });
      return { ok: true, result: data };
    }

    case 'messages.send': {
      const operationId = job.operationId || p.operationId || crypto.randomUUID();
      const data = await api.messages.send(p.roomId, p.text, { operationId });
      if (!data.ok) {
        ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
          errorCode: data.status || 'blocked_by_missing_api',
          result: data,
        });
        await emit(ctx, 'message.blocked', { code: data.status, posted: data.posted === true });
        return { ok: false, errorCode: 'needs_reconciliation', detail: data, terminal: true };
      }
      await emit(ctx, 'message.sent', { roomId: p.roomId });
      return { ok: true, result: data };
    }

    case 'project.analyze': {
      const project = p.project || (await api.projects.get(p.projectId)).project;
      if (budget) {
        const decision = budget.decide({
          intent: 'analyze_project',
          cacheKey: `analyze:${p.projectId || project?.id}`,
          estimatedTokens: 2000,
        });
        if (decision === 'budget_exceeded') {
          return { ok: false, errorCode: 'budget_exceeded', detail: {}, terminal: true };
        }
        if (decision === 'use_cache') {
          return { ok: true, result: { analysis: budget.getCache(`analyze:${p.projectId || project?.id}`), cached: true } };
        }
      }
      if (!llm) {
        return { ok: false, errorCode: 'llm_disabled', detail: { note: 'LLM provider not configured' } };
      }
      const out = await llm.analyzeProject({
        title: project?.title,
        description: project?.description,
        budget: project?.budget,
        pages: p.pages,
        integrations: p.integrations,
      });
      if (out.ok && budget) {
        budget.putCache(`analyze:${p.projectId || project?.id}`, out.data);
      }
      memoryAppend(db, {
        kind: 'project_analysis',
        refId: String(p.projectId || project?.id || ''),
        content: out.data?.summary || '',
        meta: { confidence: out.data?.confidence, source: out.source },
      });
      await emit(ctx, 'project.analyzed', { projectId: p.projectId });
      return { ok: true, result: out };
    }

    case 'proposal.draft': {
      if (!llm) {
        return { ok: false, errorCode: 'llm_disabled', detail: {} };
      }
      const out = await llm.draftProposal({
        project: p.project,
        analysis: p.analysis,
        pricing: p.pricing,
      });
      memoryAppend(db, {
        kind: 'proposal_draft',
        refId: String(p.projectId || ''),
        content: out.data?.proposal_text?.slice(0, 500) || '',
        meta: { price: out.data?.price, source: out.source },
      });
      // Draft only — never auto-send
      return { ok: true, result: { ...out, requiresApproval: true, autoSend: false } };
    }

    case 'chat.draft_reply': {
      if (!llm) {
        return { ok: false, errorCode: 'llm_disabled', detail: {} };
      }
      const out = await llm.draftChatReply({
        roomContext: p.roomContext,
        employerMessage: p.employerMessage || p.text,
      });
      return { ok: true, result: { ...out, requiresApproval: true, autoSend: false } };
    }

    case 'health.ping': {
      return { ok: true, result: { pong: true, ts: new Date().toISOString() } };
    }

    case 'reconcile.bids': {
      if (!p.projectId) return { ok: false, errorCode: 'invalid_input', detail: {} };
      const check = await api.bids.check([p.projectId]);
      return { ok: true, result: { projectId: p.projectId, weBid: check.weBidFor(p.projectId), check } };
    }

    default:
      return { ok: false, errorCode: 'unknown_goal', detail: { goal } };
  }
}

async function emit(ctx, type, payload) {
  if (typeof ctx.onEvent === 'function') {
    try {
      await ctx.onEvent(type, payload);
    } catch (e) {
      logger.warn('onEvent_failed', { type, err: e.message });
    }
  }
}
