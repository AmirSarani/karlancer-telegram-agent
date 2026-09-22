import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptEphemeral,
  decryptEphemeral,
  resolveTelegramSecretsKey,
} from '../../src/security/ephemeral-secrets.js';

const TEST_KEY = crypto.randomBytes(32).toString('hex');
const prev = process.env.TELEGRAM_SECRETS_KEY;

before(() => {
  process.env.TELEGRAM_SECRETS_KEY = TEST_KEY;
});

after(() => {
  if (prev == null) delete process.env.TELEGRAM_SECRETS_KEY;
  else process.env.TELEGRAM_SECRETS_KEY = prev;
});

test('encrypt/decrypt roundtrip for phone-like secrets', () => {
  const plain = '09121234567';
  const blob = encryptEphemeral(plain);
  assert.notEqual(blob, plain);
  assert.match(blob, /^eg1:/);
  assert.equal(blob.includes(plain), false);
  assert.equal(decryptEphemeral(blob), plain);
});

test('ciphertext differs per call (random IV)', () => {
  const a = encryptEphemeral('secret-pass');
  const b = encryptEphemeral('secret-pass');
  assert.notEqual(a, b);
  assert.equal(decryptEphemeral(a), 'secret-pass');
  assert.equal(decryptEphemeral(b), 'secret-pass');
});

test('wrong key fails decrypt', () => {
  const blob = encryptEphemeral('09120000000');
  const env = { TELEGRAM_SECRETS_KEY: crypto.randomBytes(32).toString('hex') };
  assert.throws(() => decryptEphemeral(blob, env));
});

test('resolveTelegramSecretsKey accepts hex and derives from bot token', () => {
  const hex = resolveTelegramSecretsKey({ TELEGRAM_SECRETS_KEY: TEST_KEY });
  assert.equal(hex.length, 32);
  const derived = resolveTelegramSecretsKey({ TELEGRAM_BOT_TOKEN: 'bot:fake-token-for-derive' });
  assert.equal(derived.length, 32);
  assert.throws(() => resolveTelegramSecretsKey({}), /missing_telegram_secrets_key/);
});
