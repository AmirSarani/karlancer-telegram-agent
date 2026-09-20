/**
 * MCP tool registry — limited, typed, permissioned.
 * Mutations enqueue jobs with requires_approval; they do not long-run inline.
 * Bid/chat execution uses VerifiedMutationContract only (often blocked_by_missing_api).
 */
import { z } from 'zod';
import crypto from 'node:crypto';
import { buildHealth } from '../observability/health.js';
import { memorySearch, memoryAppend } from '../memory/store.js';
import { recommendPrice } from '../intelligence/pricing.js';
import { getInsight, recordFeedback } from '../intelligence/engine.js';
import { requireToolPermission } from '../security/auth.js';
import { redactDeep } from '../security/redaction.js';
import { bidIdempotencyKey, messageIdempotencyKey } from '../api/contracts/verified-mutation.js';

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(redactDeep(obj), null, 2) }] };
}

function errResult(code, message, extra = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: code, message, ...extra }) }],
  };
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} ctx
 */
export function registerTools(server, ctx) {
  const { db, queue, api, startedAt, getScopes = () => ['admin'], getTenantId = () => 'default' } = ctx;

  const guard = (meta, fn) => async (args) => {
    const scopes = getScopes();
    if (!requireToolPermission(meta, scopes)) {
      return errResult('forbidden', `permission ${meta.permission} required`);
    }
    try {
      db.prepare(
        `INSERT INTO audit_log (id, actor, action, tool, input_hash, result_code, correlation_id, created_at, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        'mcp',
        'tool_call',
        meta.name,
        crypto.createHash('sha256').update(JSON.stringify(args || {})).digest('hex').slice(0, 16),
        'started',
        crypto.randomUUID(),
        new Date().toISOString(),
        JSON.stringify(redactDeep({ args }))
      );
    } catch {
      /* ignore audit failures */
    }
    return fn(args);
  };

  server.registerTool(
    'health.get',
    {
      description: 'Liveness/readiness summary. Use for ops checks. Not for starting jobs.',
      inputSchema: { detailed: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'health.get', permission: 'read' }, async ({ detailed }) => {
      const h = buildHealth({ db, worker: ctx.worker, startedAt });
      return textResult(detailed ? h : { status: h.status, ts: h.ts });
    })
  );

  server.registerTool(
    'rooms.list',
    {
      description: 'List Karlancer chat rooms (authenticated). Read-only.',
      inputSchema: { page: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'rooms.list', permission: 'read' }, async ({ page }) => {
      try {
        const data = await api.rooms.list({ page: page || 1 });
        return textResult({
          page: data.page,
          count: data.rooms.length,
          pagination: data.pagination,
          rooms: data.rooms.map(({ raw, ...r }) => r),
        });
      } catch (e) {
        return errResult(e.code || 'error', e.message);
      }
    })
  );

  server.registerTool(
    'project.get',
    {
      description: 'Fetch Karlancer public project by id (and optional slug). Read-only.',
      inputSchema: {
        projectId: z.union([z.string(), z.number()]),
        slug: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'project.get', permission: 'read' }, async ({ projectId, slug }) => {
      try {
        const data = await api.projects.get(projectId, { slug });
        return textResult(data);
      } catch (e) {
        return errResult(e.code || 'error', e.message);
      }
    })
  );

  server.registerTool(
    'project.list_invites',
    {
      description:
        'Enqueue a rooms.scan job to list invite-like rooms (async). Returns job_id. Requires Karlancer auth.',
      inputSchema: {
        page: z.number().int().min(1).optional(),
        keywords: z.array(z.string()).optional(),
        wait: z.boolean().optional(),
      },
    },
    guard({ name: 'project.list_invites', permission: 'read' }, async ({ page, keywords, wait }) => {
      const job = queue.create({
        goal: 'rooms.scan',
        requestedBy: 'mcp',
        tenantId: getTenantId(),
        payload: { page: page || 1, keywords },
        idempotencyKey: wait ? null : `scan:${page || 1}:${Date.now()}`,
      });
      if (wait) {
        // FIX: claim THIS job only — never steal another queued job
        const claimed = queue.claimById(job.jobId, 'mcp-inline');
        if (claimed && claimed.jobId === job.jobId) {
          const { handleJob } = await import('../worker/handlers.js');
          const outcome = await handleJob({ api, db, queue, llm: ctx.llm, budget: ctx.budget }, claimed);
          if (outcome.ok) queue.succeed(claimed.jobId, outcome.result);
          else if (outcome.terminal) {
            /* status already set */
          } else queue.fail(claimed.jobId, outcome.errorCode || 'failed', outcome.detail || {});
          return textResult({ jobId: job.jobId, ...outcome });
        }
        return textResult({
          jobId: job.jobId,
          status: queue.get(job.jobId)?.status,
          note: 'wait requested but job not claimable (status changed); poll job.get_status',
        });
      }
      return textResult({ jobId: job.jobId, status: job.status });
    })
  );

  server.registerTool(
    'room.messages',
    {
      description: 'List messages in a Karlancer room (messages-pg). Read-only.',
      inputSchema: {
        roomId: z.union([z.string(), z.number()]),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'room.messages', permission: 'read' }, async ({ roomId, page }) => {
      try {
        const data = await api.messages.list(roomId, { page: page || 1 });
        return textResult({
          roomId: data.roomId,
          page: data.page,
          count: data.messages.length,
          pagination: data.pagination,
          messages: data.messages,
        });
      } catch (e) {
        return errResult(e.code || 'error', e.message);
      }
    })
  );

  server.registerTool(
    'bids.check',
    {
      description: 'Check whether we already submitted a bid for project id(s).',
      inputSchema: {
        projectId: z.union([z.string(), z.number()]).optional(),
        projectIds: z.array(z.union([z.string(), z.number()])).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'bids.check', permission: 'read' }, async ({ projectId, projectIds }) => {
      try {
        const ids = projectIds || (projectId != null ? [projectId] : []);
        const data = await api.bids.check(ids);
        return textResult(data);
      } catch (e) {
        return errResult(e.code || 'error', e.message);
      }
    })
  );

  server.registerTool(
    'bids.submit_plan',
    {
      description:
        'Create a bid-submit job that REQUIRES human approval. Does not send the bid. Until VerifiedMutationContract exists, execution returns blocked_by_missing_api (no POST).',
      inputSchema: {
        projectId: z.union([z.string(), z.number()]),
        proposalText: z.string().min(10),
        price: z.number().positive(),
        days: z.number().int().positive(),
      },
    },
    guard({ name: 'bids.submit_plan', permission: 'write' }, async (args) => {
      const idem = bidIdempotencyKey({
        projectId: args.projectId,
        proposalText: args.proposalText,
        price: args.price,
        days: args.days,
      });
      const job = queue.create({
        goal: 'bids.submit',
        requestedBy: 'mcp',
        tenantId: getTenantId(),
        payload: args,
        requiresApproval: true,
        idempotencyKey: idem,
        operationId: idem,
        targetRef: String(args.projectId),
      });
      const approval = queue.getApprovalForJob(job.jobId);
      return textResult({
        jobId: job.jobId,
        status: job.status,
        approvalId: approval?.approval_id,
        payloadHash: approval?.payload_hash,
        note: 'Waiting for approvals.decide — bid POST blocked until VerifiedMutationContract registered',
      });
    })
  );

  server.registerTool(
    'messages.send_plan',
    {
      description:
        'Plan sending a room message (requires approval). No POST until VerifiedMutationContract.',
      inputSchema: {
        roomId: z.union([z.string(), z.number()]),
        text: z.string().min(1),
        idempotencyKey: z.string().optional(),
      },
    },
    guard({ name: 'messages.send_plan', permission: 'write' }, async (args) => {
      const opId = args.idempotencyKey || messageIdempotencyKey({ roomId: args.roomId, text: args.text });
      const job = queue.create({
        goal: 'messages.send',
        requestedBy: 'mcp',
        tenantId: getTenantId(),
        payload: { roomId: args.roomId, text: args.text, operationId: opId },
        requiresApproval: true,
        idempotencyKey: opId,
        operationId: opId,
        targetRef: String(args.roomId),
      });
      const approval = queue.getApprovalForJob(job.jobId);
      return textResult({ jobId: job.jobId, status: job.status, approvalId: approval?.approval_id, payloadHash: approval?.payload_hash });
    })
  );

  server.registerTool(
    'project.analyze_plan',
    {
      description: 'Enqueue project analysis (LLM or deterministic fallback). Does not bid/send.',
      inputSchema: {
        projectId: z.union([z.string(), z.number()]),
        pages: z.number().optional(),
        integrations: z.number().optional(),
      },
    },
    guard({ name: 'project.analyze_plan', permission: 'write' }, async (args) => {
      const job = queue.create({
        goal: 'project.analyze',
        requestedBy: 'mcp',
        tenantId: getTenantId(),
        payload: args,
        idempotencyKey: `analyze:${args.projectId}:${Date.now()}`,
      });
      return textResult({ jobId: job.jobId, status: job.status });
    })
  );

  server.registerTool(
    'proposal.draft_plan',
    {
      description: 'Enqueue proposal draft. Never auto-sends; human approval required for any bid.',
      inputSchema: {
        projectId: z.union([z.string(), z.number()]),
        project: z.record(z.unknown()).optional(),
        analysis: z.record(z.unknown()).optional(),
        pricing: z.record(z.unknown()).optional(),
      },
    },
    guard({ name: 'proposal.draft_plan', permission: 'write' }, async (args) => {
      const job = queue.create({
        goal: 'proposal.draft',
        requestedBy: 'mcp',
        tenantId: getTenantId(),
        payload: args,
        requiresApproval: false,
      });
      return textResult({ jobId: job.jobId, status: job.status, note: 'Draft only — use bids.submit_plan to propose send' });
    })
  );

  server.registerTool(
    'job.create',
    {
      description:
        'Create a durable job. Allowed goals: rooms.scan, project.get, messages.list, bids.check, health.ping, project.analyze, reconcile.bids. Mutations use *_plan tools.',
      inputSchema: {
        goal: z.enum([
          'rooms.scan',
          'project.get',
          'messages.list',
          'bids.check',
          'health.ping',
          'project.analyze',
          'reconcile.bids',
        ]),
        payload: z.record(z.unknown()).optional(),
        idempotencyKey: z.string().optional(),
      },
    },
    guard({ name: 'job.create', permission: 'write' }, async ({ goal, payload, idempotencyKey }) => {
      const job = queue.create({
        goal,
        payload: payload || {},
        requestedBy: 'mcp',
        tenantId: getTenantId(),
        idempotencyKey: idempotencyKey || null,
      });
      return textResult({ jobId: job.jobId, status: job.status });
    })
  );

  server.registerTool(
    'job.get_status',
    {
      description: 'Get job status by job_id (tenant-scoped when multi-tenant).',
      inputSchema: { jobId: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'job.get_status', permission: 'read' }, async ({ jobId }) => {
      const job = queue.get(jobId);
      if (!job) return errResult('not_found', 'job not found');
      const tenant = getTenantId();
      if (tenant !== 'default' && job.tenantId !== tenant) {
        return errResult('forbidden', 'tenant isolation');
      }
      return textResult(job);
    })
  );

  server.registerTool(
    'job.cancel',
    {
      description: 'Cancel a cancellable job (queued / waiting_for_approval).',
      inputSchema: { jobId: z.string().uuid() },
    },
    guard({ name: 'job.cancel', permission: 'write' }, async ({ jobId }) => {
      const job = queue.get(jobId);
      if (!job) return errResult('not_found', 'job not found');
      if (!['queued', 'waiting_for_approval', 'planning'].includes(job.status)) {
        return errResult('not_cancellable', `status=${job.status}`);
      }
      return textResult(queue.cancel(jobId));
    })
  );

  server.registerTool(
    'memory.search',
    {
      description: 'Search durable memory items.',
      inputSchema: {
        q: z.string().optional(),
        kind: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'memory.search', permission: 'read' }, async ({ q, kind, limit }) => {
      const items = memorySearch(db, {
        tenantId: getTenantId(),
        q: q || '',
        kind: kind || null,
        limit: limit || 20,
      });
      return textResult({ count: items.length, items });
    })
  );

  server.registerTool(
    'memory.append_event',
    {
      description: 'Append a memory note (not for secrets).',
      inputSchema: {
        kind: z.string(),
        content: z.string().min(1),
        refId: z.string().optional(),
      },
    },
    guard({ name: 'memory.append_event', permission: 'write' }, async ({ kind, content, refId }) => {
      const row = memoryAppend(db, {
        tenantId: getTenantId(),
        kind,
        content,
        refId: refId || null,
      });
      return textResult(row);
    })
  );

  server.registerTool(
    'pricing.get_recommendation',
    {
      description:
        'Deterministic pricing recommendation (rules v1). Always requires human approval before use in bids.',
      inputSchema: {
        complexity: z.enum(['low', 'medium', 'high']).optional(),
        pages: z.number().optional(),
        integrations: z.number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'pricing.get_recommendation', permission: 'read' }, async (features) => {
      return textResult(recommendPrice(features));
    })
  );

  server.registerTool(
    'pricing.record_decision',
    {
      description: 'Record a human pricing decision into memory.',
      inputSchema: {
        projectId: z.string(),
        amount: z.number(),
        note: z.string().optional(),
      },
    },
    guard({ name: 'pricing.record_decision', permission: 'write' }, async ({ projectId, amount, note }) => {
      const row = memoryAppend(db, {
        tenantId: getTenantId(),
        kind: 'pricing_decision',
        refId: projectId,
        content: `amount=${amount} ${note || ''}`.trim(),
        meta: { amount, projectId },
      });
      return textResult(row);
    })
  );

  server.registerTool(
    'approvals.list',
    {
      description: 'List pending approvals.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'approvals.list', permission: 'read' }, async () => {
      return textResult({ pending: queue.pendingApprovals(getTenantId() === 'default' ? null : getTenantId()) });
    })
  );

  server.registerTool(
    'approvals.get',
    {
      description: 'Get one approval by id.',
      inputSchema: { approvalId: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'approvals.get', permission: 'read' }, async ({ approvalId }) => {
      const a = queue.getApproval(approvalId);
      if (!a) return errResult('not_found', 'approval not found');
      return textResult(a);
    })
  );

  server.registerTool(
    'approvals.decide',
    {
      description: 'Approve or reject a pending approval (HITL). Payload tamper invalidates approval.',
      inputSchema: {
        approvalId: z.string(),
        approve: z.boolean(),
        decidedBy: z.string().optional(),
        expectedPayloadHash: z.string().optional(),
      },
    },
    guard({ name: 'approvals.decide', permission: 'approve' }, async ({ approvalId, approve, decidedBy, expectedPayloadHash }) => {
      const result = queue.decideApproval(approvalId, {
        approve,
        decidedBy: decidedBy || 'mcp',
        expectedPayloadHash: expectedPayloadHash || null,
      });
      if (!result) return errResult('not_found', 'approval not found');
      if (result.tampered) return errResult('payload_tampered', 'approval payload hash mismatch', result);
      if (result.expired) return errResult('approval_expired', 'approval expired', result);
      return textResult(result);
    })
  );

  server.registerTool(
    'audit.search',
    {
      description: 'Search recent audit log entries.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'audit.search', permission: 'read' }, async ({ limit }) => {
      const rows = db
        .prepare(
          `SELECT id, actor, action, tool, result_code, correlation_id, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?`
        )
        .all(limit || 50);
      return textResult({ count: rows.length, rows });
    })
  );

  server.registerTool(
    'intelligence.get_insight',
    {
      description:
        'Return intelligence (rules + memory). Returns insufficient_data when samples are thin. No fake ML.',
      inputSchema: {
        q: z.string().optional(),
        complexity: z.enum(['low', 'medium', 'high']).optional(),
        pages: z.number().optional(),
        integrations: z.number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard({ name: 'intelligence.get_insight', permission: 'read' }, async (args) => {
      const insight = getInsight(db, {
        features: {
          complexity: args.complexity,
          pages: args.pages,
          integrations: args.integrations,
        },
      });
      const items = memorySearch(db, {
        tenantId: getTenantId(),
        kind: 'insight',
        q: args.q || '',
        limit: 10,
      });
      return textResult({ ...insight, storedInsights: items });
    })
  );

  server.registerTool(
    'intelligence.record_feedback',
    {
      description: 'Record human decision / outcome for a recommendation (layer 5).',
      inputSchema: {
        recommendationId: z.string().optional(),
        humanDecision: z.string(),
        actualOutcome: z.string().optional(),
        feedback: z.string().optional(),
      },
    },
    guard({ name: 'intelligence.record_feedback', permission: 'write' }, async (args) => {
      const row = recordFeedback(db, { ...args, tenantId: getTenantId() });
      return textResult(row);
    })
  );
}
