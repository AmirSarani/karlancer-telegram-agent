/**
 * VerifiedMutationContract — ONLY path for production mutations (bid/chat).
 * No try-lists. Until a contract is registered from real Network evidence,
 * mutations must return blocked_by_missing_api without sending POST.
 */
import { z } from 'zod';
import crypto from 'node:crypto';
import { KarlancerApiError } from '../errors.js';

/**
 * @typedef {object} VerifiedMutationContract
 * @property {string} id
 * @property {string} capability  e.g. 'bids.submit' | 'messages.send'
 * @property {'POST'|'PUT'|'PATCH'} method
 * @property {string} pathTemplate  e.g. '/api/bids' — may include {projectId}
 * @property {import('zod').ZodTypeAny} payloadSchema
 * @property {number[]} expectedStatus  e.g. [200, 201]
 * @property {import('zod').ZodTypeAny} [responseSchema]
 * @property {string} evidence  short note / HAR hash / commit ref
 * @property {string} contractVersion
 */

/** @type {Map<string, VerifiedMutationContract>} */
const REGISTRY = new Map();

export const ALLOWED_MUTATION_CAPABILITIES = new Set([
  'bids.submit',
  'messages.send',
  'messages.mark_seen',
  'notifications.mark_read',
]);

export const ALLOWED_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Validate pathTemplate: relative /api/... only; no absolute URL; no traversal.
 */
export function assertSafeMutationPath(pathTemplate) {
  const p = String(pathTemplate || '');
  if (!p.startsWith('/api/')) {
    throw new Error('invalid_contract_path: must start with /api/');
  }
  if (p.includes('://') || p.startsWith('//')) {
    throw new Error('invalid_contract_path: absolute URL forbidden');
  }
  if (p.includes('..') || p.includes('\0')) {
    throw new Error('invalid_contract_path: traversal forbidden');
  }
  if (/\s/.test(p)) {
    throw new Error('invalid_contract_path: whitespace forbidden');
  }
  return p;
}


/**
 * Register a contract only after real Network 2xx evidence exists.
 * @param {VerifiedMutationContract} contract
 */
export function registerVerifiedMutation(contract) {
  if (!contract?.id || !contract?.capability || !contract?.pathTemplate) {
    throw new Error('invalid_contract');
  }
  if (!contract.method || !contract.evidence || !contract.contractVersion) {
    throw new Error('invalid_contract: incomplete (method/evidence/contractVersion required)');
  }
  if (!ALLOWED_MUTATION_CAPABILITIES.has(contract.capability)) {
    throw new Error(`invalid_contract: capability not allowlisted: ${contract.capability}`);
  }
  if (!ALLOWED_MUTATION_METHODS.has(String(contract.method).toUpperCase())) {
    throw new Error(`invalid_contract: method not allowed: ${contract.method}`);
  }
  assertSafeMutationPath(contract.pathTemplate);
  if (!Array.isArray(contract.expectedStatus) || contract.expectedStatus.length === 0) {
    throw new Error('invalid_contract: expectedStatus required');
  }
  if (!contract.payloadSchema || typeof contract.payloadSchema.parse !== 'function') {
    throw new Error('invalid_contract: payloadSchema must be a Zod schema');
  }
  if (REGISTRY.has(contract.capability)) {
    throw new Error(`invalid_contract: duplicate capability ${contract.capability}`);
  }
  const normalized = {
    ...contract,
    method: String(contract.method).toUpperCase(),
    pathTemplate: assertSafeMutationPath(contract.pathTemplate),
  };
  REGISTRY.set(normalized.capability, normalized);
  return normalized;
}

export function getVerifiedMutation(capability) {
  return REGISTRY.get(capability) || null;
}

export function listVerifiedMutations() {
  return [...REGISTRY.values()];
}

export function clearVerifiedMutationsForTests() {
  REGISTRY.clear();
}

/**
 * Build path from template + params.
 */
export function resolvePath(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (params[k] == null) throw new KarlancerApiError('invalid_input', `missing path param ${k}`);
    return encodeURIComponent(String(params[k]));
  });
}

/**
 * Idempotency key for bid: projectId + proposal + price + days + contract version.
 */
export function bidIdempotencyKey({ projectId, proposalText, price, days, contractVersion = 'none' }) {
  const h = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        projectId: String(projectId),
        proposalText: String(proposalText),
        price: Number(price),
        days: Number(days),
        contractVersion,
      })
    )
    .digest('hex')
    .slice(0, 24);
  return `bid:${h}`;
}

/**
 * Message send requires explicit idempotency key (caller-provided or derived).
 */
export function messageIdempotencyKey({ roomId, text, operationId }) {
  if (operationId) return `msg:${operationId}`;
  const h = crypto
    .createHash('sha256')
    .update(JSON.stringify({ roomId: String(roomId), text: String(text) }))
    .digest('hex')
    .slice(0, 24);
  return `msg:${h}`;
}

/**
 * Execute a verified mutation exactly once. On timeout / connection reset / 5xx
 * AFTER the request was sent, returns unknown_side_effect — caller MUST NOT retry POST.
 *
 * @param {import('../client.js').KarlancerClient} client
 * @param {string} capability
 * @param {{ pathParams?: object, payload: object, operationId: string }} opts
 */
export async function executeVerifiedMutation(client, capability, opts) {
  const contract = getVerifiedMutation(capability);
  if (!contract) {
    return {
      ok: false,
      status: 'blocked_by_missing_api',
      reason: `no_verified_contract:${capability}`,
      posted: false,
      operationId: opts.operationId,
    };
  }

  let payload;
  try {
    payload = contract.payloadSchema.parse(opts.payload);
  } catch (e) {
    throw new KarlancerApiError('validation', `payload schema failed: ${e.message}`);
  }

  const path = resolvePath(contract.pathTemplate, opts.pathParams || {});
  const method = contract.method || 'POST';

  try {
    // mutations: NEVER auto-retry inside client
    const res = await client.request(method, path, {
      body: payload,
      retries: 0,
      mutation: true,
      operationId: opts.operationId,
    });

    if (!contract.expectedStatus.includes(res.status)) {
      return {
        ok: false,
        status: 'unexpected_status',
        posted: true,
        httpStatus: res.status,
        operationId: opts.operationId,
        data: res.data,
        needs_reconciliation: true,
      };
    }

    if (contract.responseSchema) {
      try {
        contract.responseSchema.parse(res.data);
      } catch (e) {
        return {
          ok: false,
          status: 'response_schema_mismatch',
          posted: true,
          operationId: opts.operationId,
          data: res.data,
          needs_reconciliation: true,
          schemaError: e.message,
        };
      }
    }

    return {
      ok: true,
      status: 'succeeded',
      posted: true,
      httpStatus: res.status,
      operationId: opsafe(opts.operationId),
      endpoint: path,
      contractId: contract.id,
      contractVersion: contract.contractVersion,
      data: res.data,
    };
  } catch (e) {
    const code = e.code || 'network';
    // After send ambiguity: timeout, network reset, 5xx mapped as upstream
    if (['timeout', 'network', 'upstream_5xx'].includes(code)) {
      return {
        ok: false,
        status: 'unknown_side_effect',
        posted: true,
        needs_reconciliation: true,
        errorCode: code,
        message: e.message,
        operationId: opts.operationId,
        // CRITICAL: do not auto-retry
        retryForbidden: true,
      };
    }
    if (code === 'unauthorized') {
      return {
        ok: false,
        status: 'unauthorized',
        posted: false,
        operationId: opts.operationId,
        errorCode: code,
      };
    }
    return {
      ok: false,
      status: code,
      posted: false,
      operationId: opts.operationId,
      errorCode: code,
      message: e.message,
    };
  }
}

function opsafe(id) {
  return id;
}

/** Empty schema helpers for future registration after HAR capture */
export const BidPayloadSchema = z.object({
  project_id: z.union([z.string(), z.number()]),
  bid_id: z.union([z.number(), z.null()]).optional(),
  is_pin: z.boolean().optional().default(false),
  is_highlight: z.boolean().optional().default(false),
  is_multi: z.boolean().optional().default(false),
  description: z.string().min(1),
  edit_cart_id: z.union([z.number(), z.null()]).optional(),
  milestones: z
    .array(
      z.object({
        description: z.string(),
        duration: z.union([z.string(), z.number()]),
        budget: z.union([z.string(), z.number()]),
      })
    )
    .min(1),
});

export const MessagePayloadSchema = z.object({
  receptor_id: z.union([z.string(), z.number()]),
  room_id: z.union([z.string(), z.number()]),
  message: z.string().min(1),
  file: z
    .union([
      z.string(),
      z.object({
        name: z.string().optional(),
        url: z.string().optional(),
        size: z.number().optional(),
        type: z.string().optional(),
      }),
    ])
    .optional()
    .default(''),
});

export const NotificationsReadPayloadSchema = z.object({
  notifications: z.array(z.string()).min(1),
});


/**
 * NOTE: No contracts are pre-registered.
 * After the operator captures authenticated HAR with a real 2xx bid/send,
 * call registerVerifiedMutation(...) from a private config module loaded via env
 * (e.g. VERIFIED_MUTATION_CONFIG_PATH) — never guess endpoints.
 */
export default {
  registerVerifiedMutation,
  getVerifiedMutation,
  executeVerifiedMutation,
  bidIdempotencyKey,
  messageIdempotencyKey,
};
