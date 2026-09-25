/**
 * Job goal handlers — deterministic where possible; mutations require VerifiedMutationContract.
 */
import crypto from 'node:crypto';
import { logger } from '../observability/logger.js';
import { memoryAppend } from '../memory/store.js';
import { bidIdempotencyKey } from '../api/contracts/verified-mutation.js';
import { createRoomState } from '../agent/room-state.js';
import { runMessagesPoll } from '../agent/messages-poll.js';
import { createScanPrepare } from '../agent/scan-prepare.js';
import { createChatContinuum } from '../agent/chat-continuum.js';
import { extractPriceFeatures, extractSentPrice, recordPriceSample } from '../agent/price-memory.js';
import { createOpportunityScanner } from '../opportunity/scanner.js';

/**
 * @param {object} ctx
 * @param {ReturnType<import('../api/adapters/index.js').createKarlancerApi>} ctx.api
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {ReturnType<import('./queue.js').createJobQueue>} ctx.queue
 * @param {ReturnType<import('../llm/provider.js').createLlmProvider>} [ctx.llm]
 * @param {import('../intelligence/token-budget.js').TokenBudgetManager} [ctx.budget]
 * @param {Function} [ctx.onEvent]  projection hook
 */

const MUTATION_GOALS = new Set(['bids.submit', 'messages.send', 'messages.mark_seen']);

/**
 * Immediately before a mutation POST: re-validate approval + identity fields.
 * On any mismatch → no POST.
 */
function revalidateMutationBeforePost(ctx, job) {
  const { queue } = ctx;
  if (!MUTATION_GOALS.has(job.goal)) return { ok: true };
  const approval = queue.getApprovalForJob?.(job.jobId) || queue.getApprovalByJobId?.(job.jobId);
  // Prefer latest approval row if helper missing
  const row =
    approval ||
    (() => {
      try {
        return ctx.db
          .prepare(`SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(job.jobId);
      } catch {
        return null;
      }
    })();

  if (!row) {
    return { ok: false, errorCode: 'missing_approval', detail: { reason: 'no_approval_row' } };
  }
  if (row.status !== 'approved') {
    return { ok: false, errorCode: 'approval_not_approved', detail: { status: row.status } };
  }
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { ok: false, errorCode: 'approval_expired', detail: { expiresAt: row.expires_at } };
  }
  if ((row.tenant_id || 'default') !== (job.tenantId || 'default')) {
    return { ok: false, errorCode: 'tenant_mismatch', detail: {} };
  }
  if (row.action && row.action !== job.goal) {
    return { ok: false, errorCode: 'action_mismatch', detail: { action: row.action, goal: job.goal } };
  }
  let approvalPayload = {};
  try {
    approvalPayload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    return { ok: false, errorCode: 'approval_payload_unparseable', detail: {} };
  }
  const jobPayload = job.payload || {};
  // Exact payload identity
  if (JSON.stringify(approvalPayload) !== JSON.stringify(jobPayload)) {
    return { ok: false, errorCode: 'payload_mismatch', detail: {} };
  }
  // targetRef check when present
  const expectedTarget =
    jobPayload.projectId != null
      ? String(jobPayload.projectId)
      : jobPayload.roomId != null
        ? String(jobPayload.roomId)
        : null;
  if (row.target_ref != null && expectedTarget != null && String(row.target_ref) !== expectedTarget) {
    return { ok: false, errorCode: 'target_ref_mismatch', detail: {} };
  }
  // payload hash when present — recompute via queue helper if available
  if (row.payload_hash && typeof queue.hashApprovalPayload === 'function') {
    // no-op; hash lives on module — check stored vs job via decide path already ran
  }
  if (row.payload_hash) {
    // Compare approval payload_json bytes to job payload_json via queue.get raw if needed
    try {
      const jobRow = ctx.db.prepare(`SELECT payload_json FROM jobs WHERE job_id = ?`).get(job.jobId);
      if (jobRow && String(jobRow.payload_json || '') !== String(row.payload_json || '')) {
        return { ok: false, errorCode: 'payload_hash_mismatch', detail: { reason: 'payload_json_drift' } };
      }
    } catch {
      /* ignore if db not on ctx */
    }
  }
  return { ok: true, approval: row };
}

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
      const { rooms, pagination } = await api.rooms.list({ page });
      const list = rooms.filter(Boolean);
      const unreadOnPage = list.filter((r) => Number(r.unread) > 0).length;
      const priorityRooms = [...list]
        .sort((a, b) => {
          const au = Number(a.unread) > 0 ? 1 : 0;
          const bu = Number(b.unread) > 0 ? 1 : 0;
          if (bu !== au) return bu - au;
          const at = Date.parse(a.updatedAt || '') || 0;
          const bt = Date.parse(b.updatedAt || '') || 0;
          return bt - at;
        })
        .slice(0, 5)
        .map((r) => {
          const unread = Number(r.unread) || 0;
          return {
            guest_name: r.guestName || r.title || '—',
            roomId: r.id,
            unread,
            last_message: String(r.lastMessage || '').slice(0, 120),
            reason: unread > 0 ? 'پیام جدید' : undefined,
          };
        });

      const matched = [];
      let softFailCount = 0;
      for (const room of list) {
        try {
          const last = (room.lastMessage || '').toLowerCase();
          if (!keywords.some((kw) => last.includes(String(kw).toLowerCase()))) continue;
          const msgs = await api.messages.list(room.id, { page: 1 });
          const invite = msgs.messages.find((m) => m.projectId) || msgs.messages[0];
          if (!invite?.projectId) continue;
          const bid = await api.bids.check([invite.projectId]);
          if (bid.weBidFor(invite.projectId)) continue;
          let project = null;
          try {
            project = await api.projects.get(invite.projectId);
          } catch (e) {
            // Public project fetch may 400 for some ids — still keep invite candidate
            logger.warn('rooms_scan_project_get_failed', {
              roomId: room.id,
              projectId: invite.projectId,
              err: e.message,
              code: e.code,
            });
          }
          matched.push({
            roomId: room.id,
            projectId: invite.projectId,
            inviteText: invite.text,
            project: project?.project || null,
          });
          memoryAppend(db, {
            kind: 'invite_seen',
            refId: room.id,
            content: invite.text || project?.project?.title || room.id,
            meta: { projectId: invite.projectId },
          });
          memoryAppend(db, {
            kind: 'room_last_message',
            refId: room.id,
            content: room.lastMessage || '',
            meta: { updatedAt: room.updatedAt },
          });
        } catch (e) {
          softFailCount += 1;
          logger.warn('rooms_scan_room_failed', { roomId: room?.id, err: e.message, code: e.code });
        }
      }

      const scannedAt = new Date().toISOString();
      const matchedIds = new Set(matched.map((m) => String(m.roomId)));
      for (const pr of priorityRooms) {
        if (matchedIds.has(String(pr.roomId))) {
          pr.reason = pr.reason || 'تطابق کلیدواژه';
          pr.keywordMatched = true;
        } else if (!pr.reason) {
          // leave undefined → UX shows conservative label
        }
      }
      const matchedSlim = matched.slice(0, 10).map((m) => ({
        roomId: m.roomId,
        projectId: m.projectId,
        inviteText: m.inviteText ? String(m.inviteText).slice(0, 160) : null,
        project: m.project
          ? {
              id: m.project.id,
              title: m.project.title,
              minBudget: m.project.minBudget ?? m.project.budgetMin,
              maxBudget: m.project.maxBudget ?? m.project.budgetMax,
              skills: m.project.skills,
              category: m.project.category,
            }
          : null,
      }));
      const requestedBy = String(job.requestedBy || '');
      const isManualScan =
        Boolean(p.manual) ||
        Boolean(p.forceNotify) ||
        requestedBy.startsWith('telegram:');
      const summary = {
        page,
        total: pagination?.total ?? list.length,
        lastPage: pagination?.lastPage ?? null,
        pageCount: list.length,
        unreadOnPage,
        matchedCount: matched.length,
        matched: matchedSlim,
        priorityRooms,
        softFailCount,
        partial: softFailCount > 0,
        scannedAt,
        preparedCount: 0,
        replyApprovals: 0,
        bidApprovals: 0,
        prepareFailed: 0,
        prepareMode: 'off',
        prepareSkipped: false,
        scanTrigger: isManualScan ? 'manual' : requestedBy === 'scheduler' ? 'scheduled' : 'auto',
        forceNotify: isManualScan,
      };

      // Brain: auto-prepare drafts → HITL when Assisted/Auto or chat AI pick/full_auto
      // (or payload.forcePrepare from «تحلیل همه»). Never live-send from this path.
      if (priorityRooms.length || matched.length) {
        try {
          const preparer = createScanPrepare({
            db,
            api,
            mutations: ctx.mutations || null,
            llm: ctx.llm || null,
            queue: ctx.queue || null,
            budget: ctx.budget || null,
          });
          const prep = await preparer.prepareScanHits({
            priorityRooms,
            matched,
            max: p.prepareMax,
            force: Boolean(p.forcePrepare),
          });
          summary.prepareMode = prep.prepareMode || (prep.skipped ? 'manual_offer' : 'auto');
          summary.prepareSkipped = Boolean(prep.skipped);
          summary.preparedCount = Number(prep.preparedCount) || 0;
          summary.replyApprovals = Number(prep.replyApprovals) || 0;
          summary.bidApprovals = Number(prep.bidApprovals) || 0;
          summary.prepareFailed = Number(prep.failed) || 0;
          summary.analyzedCount = Number(prep.analyzed) || 0;
          if (prep.error) summary.prepareError = prep.error;
        } catch (e) {
          logger.warn('rooms_scan_prepare_failed', { err: e.message });
          summary.prepareFailed = (summary.prepareFailed || 0) + 1;
          summary.prepareError = e.message;
        }
      } else {
        summary.prepareMode = 'empty';
      }

      // Persist for /status and /start (optional kv)
      try {
        db.prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES ('last_scan_summary', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(JSON.stringify(summary), scannedAt);
      } catch (e) {
        logger.warn('last_scan_kv_failed', { err: e.message });
      }
      await emit(ctx, 'rooms.scanned', summary);
      return { ok: true, result: { ...summary, matched } };
    }

    case 'rooms.prepare_scan': {
      // One-tap «تحلیل همه» — prepare from last scan summary without re-listing rooms.
      let last = null;
      try {
        const row = db.prepare(`SELECT value FROM kv WHERE key = 'last_scan_summary'`).get();
        if (row?.value) last = JSON.parse(row.value);
      } catch (e) {
        logger.warn('prepare_scan_read_last_failed', { err: e.message });
      }
      if (!last?.priorityRooms?.length && !last?.matched?.length) {
        // matched is not always persisted on summary — rebuild from priority only
        if (!last?.priorityRooms?.length) {
          return {
            ok: true,
            result: {
              skipped: true,
              reason: 'no_last_scan',
              preparedCount: 0,
              prepareMode: 'empty',
            },
          };
        }
      }
      const preparer = createScanPrepare({
        db,
        api,
        mutations: ctx.mutations || null,
        llm: ctx.llm || null,
        queue: ctx.queue || null,
        budget: ctx.budget || null,
      });
      const prep = await preparer.prepareScanHits({
        priorityRooms: last.priorityRooms || [],
        matched: last.matched || [],
        max: p.prepareMax,
        force: true,
      });
      const scannedAt = new Date().toISOString();
      const summary = {
        ...last,
        scannedAt,
        preparedCount: Number(prep.preparedCount) || 0,
        replyApprovals: Number(prep.replyApprovals) || 0,
        bidApprovals: Number(prep.bidApprovals) || 0,
        prepareFailed: Number(prep.failed) || 0,
        prepareMode: prep.prepareMode || 'forced',
        prepareSkipped: false,
        analyzedCount: Number(prep.analyzed) || 0,
        // User tapped «تحلیل همه» — always show result card
        scanTrigger: 'manual',
        forceNotify: true,
      };
      try {
        db.prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES ('last_scan_summary', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(JSON.stringify(summary), scannedAt);
      } catch (e) {
        logger.warn('last_scan_kv_failed', { err: e.message });
      }
      await emit(ctx, 'rooms.scanned', summary);
      return { ok: true, result: { ...summary, prepareItems: prep.items } };
    }


    case 'messages.poll': {
      const roomState = createRoomState(db);
      const out = await runMessagesPoll(
        {
          api,
          db,
          roomState,
          llm: ctx.llm || null,
          gate: ctx.gate || null,
          mutations: ctx.mutations || null,
          budget: ctx.budget || null,
          getAllowLiveAutoSend:
            typeof ctx.getAllowLiveAutoSend === 'function'
              ? ctx.getAllowLiveAutoSend
              : () => Boolean(ctx.allowLiveAutoSend),
        },
        p
      );
      if (!out.ok) {
        return { ok: false, errorCode: out.errorCode, detail: out.detail };
      }
      await emit(ctx, 'messages.polled', {
        polledAt: out.result.polledAt,
        freshCount: out.result.freshCount,
        newCards: out.result.newCards,
        pendingDecisions: out.result.pendingDecisions,
        unreadOnPage: out.result.unreadOnPage,
        sendApiLive: out.result.sendApiLive,
        cards: out.result.cards,
        priorityUnread: out.result.priorityUnread,
        chatAiMode: out.result.chatAiMode,
        continuumActions: out.result.continuumActions,
      });
      return out;
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
      {
        const v = revalidateMutationBeforePost(ctx, job);
        if (!v.ok) {
          ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
            errorCode: v.errorCode,
            result: v.detail,
          });
          await emit(ctx, 'bid.blocked', { code: v.errorCode, projectId: p.projectId, posted: false });
          return { ok: false, errorCode: v.errorCode, detail: v.detail, terminal: true, posted: false };
        }
      }
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
          await emit(ctx, 'bid.blocked', { code: 'bid_not_visible_yet', projectId: p.projectId, posted: true });
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
      const roomState = createRoomState(db);
      const roomId = p.roomId != null ? String(p.roomId) : null;
      const isAuto = String(job.requestedBy || '').startsWith('chat_continuum') || String(job.requestedBy || '').startsWith('followup');
      const guestName = roomId ? roomState.getCard(roomId)?.guestName || null : null;
      {
        const v = revalidateMutationBeforePost(ctx, job);
        if (!v.ok) {
          ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
            errorCode: v.errorCode,
            result: v.detail,
          });
          await emit(ctx, 'message.blocked', { roomId, guestName, code: v.errorCode, posted: false, auto: isAuto, stage: 'revalidate' });
          return { ok: false, errorCode: v.errorCode, detail: v.detail, terminal: true, posted: false };
        }
      }
      // Double-send guard: a newer message already went to this room after this draft was queued.
      if (roomId) {
        const thread = roomState.getThread(roomId);
        const sentAt = Date.parse(thread.lastSentAt || '');
        const createdAt = Date.parse(job.createdAt || '');
        if (Number.isFinite(sentAt) && Number.isFinite(createdAt) && sentAt > createdAt) {
          ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
            errorCode: 'superseded_by_newer_send',
            result: { lastSentAt: thread.lastSentAt },
          });
          await emit(ctx, 'message.blocked', { roomId, guestName, code: 'superseded_by_newer_send', posted: false, auto: isAuto, stage: 'guard' });
          return { ok: false, errorCode: 'superseded_by_newer_send', terminal: true, posted: false };
        }
      }
      const operationId = job.operationId || p.operationId || crypto.randomUUID();
      const data = await api.messages.send(p.roomId, p.text, { operationId, receptorId: p.receptorId });
      if (!data.ok) {
        ctx.queue.setStatus(job.jobId, 'needs_reconciliation', {
          errorCode: data.status || 'blocked_by_missing_api',
          result: data,
        });
        if (roomId) {
          roomState.setDecision(roomId, { status: 'blocked', detail: data.status || 'blocked_by_missing_api' });
        }
        await emit(ctx, 'message.blocked', {
          roomId,
          guestName,
          code: data.status,
          posted: data.posted === true,
          auto: isAuto,
          stage: 'post',
        });
        return { ok: false, errorCode: 'needs_reconciliation', detail: data, terminal: true };
      }
      // Learn: price actually sent in chat (Toman) with room features.
      let sentPrice = null;
      if (roomId && !p.followUp) {
        try {
          sentPrice = extractSentPrice(p.text);
          if (sentPrice) {
            const rc = roomState.getCard(roomId) || {};
            recordPriceSample(db, {
              amount: sentPrice,
              source: 'sent',
              roomId,
              projectId: rc.project?.id ?? null,
              features: extractPriceFeatures({ project: rc.project || null, messages: rc.messages || [] }),
            });
          }
        } catch (e) {
          logger.warn('price_sample_record_failed', { err: e.message });
        }
      }
      if (roomId) {
        roomState.markAnswered(roomId, {
          lastSentText: p.text,
          summary: roomState.getThread(roomId)?.summary || null,
        });
        roomState.setThread(roomId, { pendingSendJobId: null });
        if (p.followUp) {
          const th = roomState.getThread(roomId);
          roomState.setThread(roomId, { followUpCount: (Number(th.followUpCount) || 0) + 1, lastFollowUpAt: new Date().toISOString() });
        }
      }
      await emit(ctx, 'message.sent', {
        roomId,
        guestName,
        auto: isAuto,
        followUp: Boolean(p.followUp),
        textPreview: String(p.text || '').slice(0, 160),
        price: sentPrice ?? p.price ?? null,
      });
      return { ok: true, result: data };
    }

    case 'chat.resume_price': {
      // Owner answered «چه قیمتی بدهم؟» → continue the auto path (same gate / mutation contract).
      const roomState = createRoomState(db);
      const continuum = createChatContinuum({
        db,
        roomState,
        llm: ctx.llm || null,
        gate: ctx.gate || null,
        mutations: ctx.mutations || null,
        budget: ctx.budget || null,
        getAllowLiveAutoSend:
          typeof ctx.getAllowLiveAutoSend === 'function'
            ? ctx.getAllowLiveAutoSend
            : () => Boolean(ctx.allowLiveAutoSend),
      });
      const out = await continuum.resumeAfterPrice(p.roomId);
      if (!out.ok) return { ok: false, errorCode: out.reason, detail: {}, terminal: true };
      await emit(ctx, 'chat.price_resumed', { roomId: String(p.roomId), card: out.card });
      return { ok: true, result: { roomId: String(p.roomId), action: out.card?.continuumAction } };
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

    case 'opportunities.scan': {
      const scanner = createOpportunityScanner({
        db,
        api,
        mutations: ctx.mutations || null,
        tenantId: job.tenantId || 'default',
        notify: ctx.notifyOpportunity || null,
        allowLiveAutoBid: typeof ctx.getAllowLiveAutoBid === 'function' ? Boolean(ctx.getAllowLiveAutoBid()) : Boolean(ctx.allowLiveAutoBid),
      });
      // Respect agent pause / emergency via scanner internals + settings
      const settings = scanner.settingsStore.get();
      if (settings.emergencyStop && !p.manual) {
        // still allow analyze-only path inside scanner; it downgrades AUTO_EXECUTE
      }
      const out = await scanner.scan({
        manual: Boolean(p.manual),
        pages: p.pages || 1,
        includeInvites: p.includeInvites !== false,
        searchParams: p.searchParams || {},
      });
      await emit(ctx, 'opportunities.scanned', {
        scannedAt: out.scannedAt,
        scanned: out.scanned,
        newCount: out.newCount,
        matched: out.matched,
        drafts: out.drafts,
        notified: out.notified,
        approvals: out.approvals,
        autoExecuted: out.autoExecuted,
        skipped: out.skipped || false,
        reason: out.reason || null,
      });
      return { ok: Boolean(out.ok), result: out };
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
