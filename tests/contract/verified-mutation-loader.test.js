import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registerVerifiedMutation,
  clearVerifiedMutationsForTests,
  assertSafeMutationPath,
  ALLOWED_MUTATION_CAPABILITIES,
  BidPayloadSchema,
  listVerifiedMutations,
} from '../../src/api/contracts/verified-mutation.js';
import { loadLocalVerifiedMutations } from '../../src/api/contracts/load-local.js';

test('assertSafeMutationPath rejects absolute URL and traversal', () => {
  assert.throws(() => assertSafeMutationPath('https://evil.test/api/bids'));
  assert.throws(() => assertSafeMutationPath('/api/../etc/passwd'));
  assert.throws(() => assertSafeMutationPath('/v1/bids'));
  assert.equal(assertSafeMutationPath('/api/bids'), '/api/bids');
});

test('registerVerifiedMutation fail-closed on incomplete / unknown capability / duplicate', () => {
  clearVerifiedMutationsForTests();
  assert.throws(() =>
    registerVerifiedMutation({
      id: 'x',
      capability: 'bids.submit',
      pathTemplate: '/api/bids',
    })
  );
  assert.throws(() =>
    registerVerifiedMutation({
      id: 'x',
      capability: 'guessed.endpoint',
      method: 'POST',
      pathTemplate: '/api/bids',
      expectedStatus: [200],
      payloadSchema: BidPayloadSchema,
      evidence: 'e',
      contractVersion: '1',
    })
  );
  registerVerifiedMutation({
    id: 'ok',
    capability: 'bids.submit',
    method: 'POST',
    pathTemplate: '/api/bids',
    expectedStatus: [200],
    payloadSchema: BidPayloadSchema,
    evidence: 'har',
    contractVersion: '1',
  });
  assert.throws(() =>
    registerVerifiedMutation({
      id: 'dup',
      capability: 'bids.submit',
      method: 'POST',
      pathTemplate: '/api/bids',
      expectedStatus: [200],
      payloadSchema: BidPayloadSchema,
      evidence: 'har',
      contractVersion: '1',
    })
  );
  assert.ok(ALLOWED_MUTATION_CAPABILITIES.has('bids.submit'));
  clearVerifiedMutationsForTests();
});

test('loadLocalVerifiedMutations: unknown schema does NOT become z.any; fail-closed', () => {
  clearVerifiedMutationsForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-vm-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      contracts: [
        {
          id: 'x',
          capability: 'bids.submit',
          method: 'POST',
          pathTemplate: '/api/bids',
          expectedStatus: [200],
          contractVersion: '1',
          evidence: 'e',
          payloadSchema: 'totally_unknown',
        },
      ],
    })
  );
  assert.throws(
    () => loadLocalVerifiedMutations({ VERIFIED_MUTATION_CONFIG_PATH: file }),
    /unknown payloadSchema|not z\.any/
  );
  assert.equal(listVerifiedMutations().length, 0);
  clearVerifiedMutationsForTests();
});
