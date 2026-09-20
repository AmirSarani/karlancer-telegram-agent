/**
 * Optionally load VerifiedMutationContract from gitignored JSON.
 * Path: VERIFIED_MUTATION_CONFIG_PATH or configs/verified-mutations.local.json
 * Never commit that file.
 *
 * Fail-closed: unknown payloadSchema does NOT become z.any();
 * invalid/incomplete/duplicate contracts abort the whole load (0 registered from file).
 * Shape:
 * { "contracts": [ { id, capability, method, pathTemplate, expectedStatus, contractVersion, evidence,
 *   payloadSchema: "bid"|"message" } ] }
 */
import fs from 'node:fs';
import {
  registerVerifiedMutation,
  BidPayloadSchema,
  MessagePayloadSchema,
  ALLOWED_MUTATION_CAPABILITIES,
} from './verified-mutation.js';
import { logger } from '../../observability/logger.js';

const schemas = {
  bid: BidPayloadSchema,
  message: MessagePayloadSchema,
};

export function loadLocalVerifiedMutations(env = process.env) {
  const p = env.VERIFIED_MUTATION_CONFIG_PATH || 'configs/verified-mutations.local.json';
  if (!fs.existsSync(p)) return 0;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    logger.error('verified_mutations_load_failed', { err: e.message, path: p, failClosed: true });
    throw new Error(`verified_mutations_load_failed: ${e.message}`);
  }
  const contracts = raw.contracts || [];
  if (!Array.isArray(contracts)) {
    throw new Error('verified_mutations_load_failed: contracts must be an array');
  }
  // Validate all first (fail-closed); do not partially register.
  const prepared = [];
  const seenCaps = new Set();
  for (const c of contracts) {
    if (!c?.id || !c?.capability || !c?.method || !c?.pathTemplate || !c?.evidence || !c?.contractVersion) {
      throw new Error(`verified_mutations_load_failed: incomplete contract ${c?.id || c?.capability || '?'}`);
    }
    if (!ALLOWED_MUTATION_CAPABILITIES.has(c.capability)) {
      throw new Error(`verified_mutations_load_failed: capability not allowlisted: ${c.capability}`);
    }
    if (seenCaps.has(c.capability)) {
      throw new Error(`verified_mutations_load_failed: duplicate capability ${c.capability}`);
    }
    seenCaps.add(c.capability);
    if (!(c.payloadSchema in schemas)) {
      // Unknown schema must NOT become z.any()
      throw new Error(`verified_mutations_load_failed: unknown payloadSchema '${c.payloadSchema}' (not z.any)`);
    }
    if (!Array.isArray(c.expectedStatus) || c.expectedStatus.length === 0) {
      throw new Error(`verified_mutations_load_failed: expectedStatus required for ${c.capability}`);
    }
    prepared.push({
      ...c,
      payloadSchema: schemas[c.payloadSchema],
      // responseSchema optional; unknown names rejected (no z.any fallback)
      responseSchema: undefined,
    });
  }
  let n = 0;
  for (const c of prepared) {
    registerVerifiedMutation(c);
    n += 1;
  }
  logger.info('verified_mutations_loaded', { count: n, path: p });
  return n;
}
