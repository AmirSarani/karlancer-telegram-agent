/**
 * Optionally load VerifiedMutationContract from gitignored JSON.
 * Path: VERIFIED_MUTATION_CONFIG_PATH or configs/verified-mutations.local.json
 * Never commit that file. Shape:
 * { "contracts": [ { id, capability, method, pathTemplate, expectedStatus, contractVersion, evidence,
 *   payloadSchema: "bid"|"message"|"any" } ] }
 */
import fs from 'node:fs';
import { z } from 'zod';
import {
  registerVerifiedMutation,
  BidPayloadSchema,
  MessagePayloadSchema,
} from './verified-mutation.js';
import { logger } from '../../observability/logger.js';

const schemas = {
  bid: BidPayloadSchema,
  message: MessagePayloadSchema,
  any: z.any(),
};

export function loadLocalVerifiedMutations(env = process.env) {
  const p = env.VERIFIED_MUTATION_CONFIG_PATH || 'configs/verified-mutations.local.json';
  if (!fs.existsSync(p)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    let n = 0;
    for (const c of raw.contracts || []) {
      registerVerifiedMutation({
        ...c,
        payloadSchema: schemas[c.payloadSchema] || z.any(),
        responseSchema: c.responseSchema === 'any' ? z.any() : undefined,
      });
      n += 1;
    }
    logger.info('verified_mutations_loaded', { count: n, path: p });
    return n;
  } catch (e) {
    logger.warn('verified_mutations_load_failed', { err: e.message });
    return 0;
  }
}
