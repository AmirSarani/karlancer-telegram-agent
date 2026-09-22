import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHttpsOnlyUrl, assertAllowedUrl } from '../../src/security/redaction.js';
import { loadAppConfig } from '../../src/config.js';
import { KarlancerClient } from '../../src/api/client.js';
import { createAuthAdapter } from '../../src/api/adapters/auth.js';

test('assertHttpsOnlyUrl rejects http base URLs', () => {
  assert.throws(() => assertHttpsOnlyUrl('KARLANCER_BASE_URL', 'http://www.karlancer.com'), /https_required/);
  assert.throws(() => assertHttpsOnlyUrl('OPENAI_BASE_URL', 'http://api.openai.com/v1'), /https_required/);
  assertHttpsOnlyUrl('KARLANCER_BASE_URL', 'https://www.karlancer.com');
});

test('loadAppConfig rejects http KARLANCER_BASE_URL', () => {
  const prevK = process.env.KARLANCER_BASE_URL;
  const prevT = process.env.ENABLE_TELEGRAM;
  process.env.ENABLE_TELEGRAM = 'false';
  process.env.KARLANCER_BASE_URL = 'http://www.karlancer.com';
  try {
    assert.throws(() => loadAppConfig({ requireTelegram: false, requireOwner: false }), /https_required/);
  } finally {
    if (prevK == null) delete process.env.KARLANCER_BASE_URL;
    else process.env.KARLANCER_BASE_URL = prevK;
    if (prevT == null) delete process.env.ENABLE_TELEGRAM;
    else process.env.ENABLE_TELEGRAM = prevT;
  }
});

test('loginWithPhone posts over https Karlancer base (asserted by client)', async () => {
  const calls = [];
  const client = new KarlancerClient({
    baseUrl: 'https://www.karlancer.com',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      assert.match(String(url), /^https:\/\//);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'success',
            data: { access_token: '1|x', token_type: 'Bearer', user: { id: 9 } },
          }),
        headers: new Map(),
      };
    },
  });
  const auth = createAuthAdapter(client);
  const out = await auth.loginWithPhone({ phone: '09121111111', password: 'pw' });
  assert.equal(out.accessToken, '1|x');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.karlancer.com/api/login/phone');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.phone, '09121111111');

  assert.throws(() => new KarlancerClient({ baseUrl: 'http://www.karlancer.com' }), /https_required/);
  assert.throws(() => assertAllowedUrl('http://api.telegram.org'), /https_required/);
});
