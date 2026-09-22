import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginRelogin,
  beginPasswordFallback,
  clearReloginState,
  getReloginState,
  handleReloginText,
  normalizePhone,
  maybeNotifySessionExpired,
  MSG,
  _resetReloginForTests,
  _reloginStateSizeForTests,
} from '../../src/telegram/relogin-flow.js';
import { extractAccessToken } from '../../src/api/adapters/auth.js';
import {
  persistAccessToken,
  looksLikeSecretLeak,
} from '../../src/security/persist-access-token.js';
import {
  parseCallbackData,
  settingsInlineKeyboard,
  formatSettingsCard,
  formatHelp,
} from '../../src/telegram/ui.js';
import { resolveOwnerChatIds, isOwnerContext } from '../../src/telegram/bot.js';
import { KarlancerApiError } from '../../src/api/errors.js';
import crypto from 'node:crypto';
const _prevSecretsKey = process.env.TELEGRAM_SECRETS_KEY;
before(() => {
  process.env.TELEGRAM_SECRETS_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (_prevSecretsKey == null) delete process.env.TELEGRAM_SECRETS_KEY;
  else process.env.TELEGRAM_SECRETS_KEY = _prevSecretsKey;
});

test('normalizePhone accepts IR mobiles and rejects junk', () => {
  assert.equal(normalizePhone('0912-345-6789'), '09123456789');
  assert.equal(normalizePhone('+989123456789'), '09123456789');
  assert.equal(normalizePhone('۰۹۱۲۳۴۵۶۷۸۹'), '09123456789');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone(''), null);
});

test('relogin state machine: begin → await_choice; clear; timeout', async () => {
  _resetReloginForTests();
  const chatId = 1366010187;
  beginRelogin(chatId, 50);
  const st = getReloginState(chatId);
  assert.equal(st.phase, 'await_choice');
  assert.equal(_reloginStateSizeForTests(), 1);
  clearReloginState(chatId);
  assert.equal(getReloginState(chatId), null);

  beginRelogin(chatId, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getReloginState(chatId), null);
});

test('owner gate helpers still restrict to allowlist', () => {
  const owners = resolveOwnerChatIds({
    ownerChatIds: [1366010187, 1773932361],
  });
  assert.deepEqual(owners, [1366010187, 1773932361]);
  assert.equal(isOwnerContext({ chat: { id: 1366010187 }, from: { id: 1 } }, owners), true);
  assert.equal(isOwnerContext({ chat: { id: 999 }, from: { id: 999 } }, owners), false);
});

test('settings UX exposes relogin callback and help warns about Telegram history', () => {
  const kb = settingsInlineKeyboard('running');
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('set:relogin'));
  assert.deepEqual(parseCallbackData('set:relogin'), { type: 'set_relogin' });
  assert.deepEqual(parseCallbackData('set:relogin:cancel'), { type: 'set_relogin_cancel' });
  const card = formatSettingsCard({ state: 'running', karlancerAuth: false });
  assert.match(card, /تمدید نشست/);
  assert.match(card, /تمدید نشست|توکن مرورگر|کنترل سیستم/);
  const help = formatHelp();
  assert.match(help, /نشست|توکن مرورگر/);
  assert.match(help, /نگه ندارید|چت/);
  assert.match(help, /کنترل سیستم/);
  assert.match(help, /E2E/);
});

test('relogin stores phone as ciphertext only (no plaintext in state)', async () => {
  _resetReloginForTests();
  const chatId = 999001;
  beginPasswordFallback(chatId);
  const replies = [];
  const deleted = [];
  await handleReloginText({
    ctx: mockCtx(chatId, '09123334455', 5, replies, deleted),
    api: { client: {} },
  });
  const st = getReloginState(chatId);
  assert.equal(st.phase, 'await_password');
  assert.ok(st.phoneCipher);
  assert.equal(st.phone, undefined);
  assert.equal(JSON.stringify(st).includes('09123334455'), false);
});

test('extractAccessToken reads Sanctum-style payload', () => {
  const token = extractAccessToken({
    status: 'success',
    data: { access_token: '42|secretVALUE', token_type: 'Bearer' },
  });
  assert.equal(token, '42|secretVALUE');
  assert.equal(extractAccessToken({}), null);
});

test('persistAccessToken writes .env safely and hot-swaps client (no secret in result)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karlancer-env-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'FOO=bar\nKARLANCER_ACCESS_TOKEN=old|token\nBAZ=1\n');
  const calls = [];
  const client = {
    setAccessToken(t) {
      calls.push(t);
    },
  };
  const secret = '99|newTokenWithPipe';
  const out = persistAccessToken(secret, { envFile, client, env: {} });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [secret]);
  const body = fs.readFileSync(envFile, 'utf8');
  assert.match(body, /^FOO=bar$/m);
  assert.match(body, /^BAZ=1$/m);
  assert.match(body, /^KARLANCER_ACCESS_TOKEN=99\|newTokenWithPipe$/m);
  assert.equal(JSON.stringify(out).includes(secret), false);
  assert.equal(looksLikeSecretLeak(JSON.stringify(out), [secret]), false);
});

function mockCtx(chatId, text, messageId, replies, deleted) {
  return {
    chat: { id: chatId },
    message: { text, message_id: messageId },
    reply: async (t) => {
      replies.push(t);
    },
    api: {
      deleteMessage: async (_chat, mid) => {
        deleted.push(mid);
      },
    },
  };
}

test('handleReloginText happy path mocks login; never puts password in replies/logs', async () => {
  _resetReloginForTests();
  const chatId = 1773932361;
  beginPasswordFallback(chatId);
  const replies = [];
  const logs = [];
  const deleted = [];

  await handleReloginText({
    ctx: mockCtx(chatId, '09121234567', 11, replies, deleted),
    api: { client: {} },
    logInfo: (m, f) => logs.push({ m, f }),
    logWarn: (m, f) => logs.push({ m, f }),
  });
  assert.equal(getReloginState(chatId).phase, 'await_password');
  assert.match(replies.at(-1), /رمز/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karlancer-env-'));
  const envFile = path.join(dir, '.env');
  const password = 'SuperSecret-Pass-NOT-IN-LOGS';
  let loginCalled = false;
  const api = {
    client: {
      accessToken: '',
      setAccessToken(t) {
        this.accessToken = t;
      },
      async post(p, body, opts) {
        loginCalled = true;
        assert.equal(p, '/api/login/phone');
        assert.equal(opts.auth, false);
        assert.equal(body.phone, '09121234567');
        assert.equal(body.password, password);
        assert.equal(body.unregistered_project_token, null);
        assert.equal(body.unregistered_service_token, null);
        assert.equal(body.role, '');
        return {
          status: 200,
          data: {
            status: 'success',
            data: { access_token: '7|tok', token_type: 'Bearer', user: { id: 1 } },
          },
        };
      },
    },
  };

  await handleReloginText({
    ctx: {
      ...mockCtx(chatId, password, 12, replies, deleted),
      reply: async (text) => {
        replies.push(text);
        assert.equal(text.includes(password), false);
      },
    },
    api,
    envFile,
    logInfo: (m, f) => {
      logs.push({ m, f });
      assert.equal(looksLikeSecretLeak(JSON.stringify({ m, f }), [password, '7|tok']), false);
    },
    logWarn: (m, f) => logs.push({ m, f }),
  });

  assert.equal(loginCalled, true);
  assert.equal(api.client.accessToken, '7|tok');
  assert.equal(getReloginState(chatId), null);
  assert.equal(replies.at(-1), MSG.SUCCESS);
  assert.ok(deleted.includes(12));
  const envBody = fs.readFileSync(envFile, 'utf8');
  assert.match(envBody, /KARLANCER_ACCESS_TOKEN=7\|tok/);
  assert.equal(looksLikeSecretLeak(JSON.stringify(logs), [password]), false);
});

test('handleReloginText wrong password stays in flow with Persian error', async () => {
  _resetReloginForTests();
  const chatId = 42;
  beginPasswordFallback(chatId);
  const replies = [];
  const deleted = [];
  const api = {
    client: {
      async post() {
        throw new KarlancerApiError('unauthorized', 'Karlancer auth failed', { status: 401 });
      },
    },
  };
  await handleReloginText({
    ctx: mockCtx(chatId, '09120000000', 1, replies, deleted),
    api,
  });
  await handleReloginText({
    ctx: mockCtx(chatId, 'wrong-pass', 2, replies, deleted),
    api,
  });
  assert.equal(getReloginState(chatId).phase, 'await_password');
  assert.equal(replies.at(-1), MSG.BAD_PASSWORD);
  assert.equal(looksLikeSecretLeak(replies.join('\n'), ['wrong-pass']), false);
});

test('maybeNotifySessionExpired is rate-limited', async () => {
  _resetReloginForTests();
  const sent = [];
  const notify = async (id, text) => {
    sent.push({ id, text });
  };
  const owners = [1, 2];
  assert.equal(
    await maybeNotifySessionExpired({ notify, ownerChatIds: owners, now: 1000, cooldownMs: 5000 }),
    true
  );
  assert.equal(sent.length, 2);
  assert.equal(
    await maybeNotifySessionExpired({ notify, ownerChatIds: owners, now: 2000, cooldownMs: 5000 }),
    false
  );
  assert.equal(sent.length, 2);
  assert.equal(
    await maybeNotifySessionExpired({ notify, ownerChatIds: owners, now: 7000, cooldownMs: 5000 }),
    true
  );
  assert.equal(sent.length, 4);
  assert.ok(sent.every((s) => s.text === MSG.SESSION_EXPIRED));
});
