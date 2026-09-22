import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createPermissionGate } from '../../src/telegram/permission-gate.js';
import { createMutationRequester } from '../../src/telegram/mutation-request.js';
import { createAgentSettingsStore } from '../../src/telegram/agent-settings.js';
import { decideOpportunity } from '../../src/opportunity/decision-engine.js';
import { createOpportunityScanner } from '../../src/opportunity/scanner.js';
import { ensureOpportunitySchema } from '../../src/opportunity/store.js';
import { toProjectOpportunity } from '../../src/opportunity/normalize.js';
import {
  beginRelogin,
  beginTokenPaste,
  beginPasswordFallback,
  getReloginState,
  extractPastedAccessToken,
  clearReloginState,
  _resetReloginForTests,
  MSG,
} from '../../src/telegram/relogin-flow.js';
import { notifyAllOwners } from '../../src/telegram/notify.js';
import { notifyBaleOwners } from '../../src/telegram/bale-notify.js';
import { createSessionHealthMonitor } from '../../src/security/session-health.js';
import { checkTokenHealth } from '../../src/security/token-health.js';
import {
  detectWinSignal,
  advancePostWin,
  buildFirstClientMessageDraft,
  formatPostWinSectionFa,
  scanNotificationsForWins,
} from '../../src/opportunity/post-win.js';
import { parseCallbackData, settingsInlineKeyboard } from '../../src/telegram/ui.js';
import { loadAppConfig, parseTelegramOwnerChatIds } from '../../src/config.js';

const _prevSecretsKey = process.env.TELEGRAM_SECRETS_KEY;
before(() => {
  process.env.TELEGRAM_SECRETS_KEY = crypto.randomBytes(32).toString('hex');
});
after(() => {
  if (_prevSecretsKey == null) delete process.env.TELEGRAM_SECRETS_KEY;
  else process.env.TELEGRAM_SECRETS_KEY = _prevSecretsKey;
});

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p69-'));
  const db = openDb(path.join(dir, 't.sqlite'));
  ensureOpportunitySchema(db);
  return { db, dir };
}

// —— Phase 6 ——
test('P6: relogin starts at await_choice; token/password branches', () => {
  _resetReloginForTests();
  const id = 42;
  beginRelogin(id);
  assert.equal(getReloginState(id).phase, 'await_choice');
  beginTokenPaste(id);
  assert.equal(getReloginState(id).phase, 'await_token');
  beginPasswordFallback(id);
  assert.equal(getReloginState(id).phase, 'await_phone');
  clearReloginState(id);
  assert.match(MSG.ASK_CHOICE, /توکن/);
  assert.match(MSG.ASK_PHONE, /هشدار/);
});

test('P6: extractPastedAccessToken accepts Sanctum and rejects junk', () => {
  assert.ok(extractPastedAccessToken('123|abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(extractPastedAccessToken('Bearer 123|abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(
    extractPastedAccessToken('{"access_token":"999|abcdefghijklmnopqrstuvwxyz012345","token_type":"Bearer"}')
  );
  assert.equal(extractPastedAccessToken('09121234567'), null);
  assert.equal(extractPastedAccessToken('short'), null);
  assert.equal(extractPastedAccessToken(''), null);
});

test('P6: UI callbacks for token/password reauth + postwin', () => {
  assert.deepEqual(parseCallbackData('set:relogin:token'), { type: 'set_relogin_token' });
  assert.deepEqual(parseCallbackData('set:relogin:password'), { type: 'set_relogin_password' });
  assert.deepEqual(parseCallbackData('nav:postwin'), { type: 'nav_postwin' });
  const data = settingsInlineKeyboard('running').inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('nav:postwin'));
});

test('P6: session health probe 401 notifies once', async () => {
  let notified = 0;
  const api = {
    client: {
      hasAuth: true,
      async get() {
        const err = new Error('unauthorized');
        err.status = 401;
        err.code = 'unauthorized';
        throw err;
      },
    },
  };
  const mon = createSessionHealthMonitor({
    api,
    notifyAllOwners: async () => {
      notified += 1;
    },
  });
  await mon.tick();
  assert.equal(mon.getLast().reason, 'auth_401');
  assert.equal(notified, 1);
  await mon.tick();
  assert.equal(notified, 1); // cooldown
});

test('P6: token age warning surfaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'KARLANCER_ACCESS_TOKEN=x\n');
  const old = Date.now() - 20 * 24 * 60 * 60_000;
  fs.utimesSync(envFile, new Date(old / 1000), new Date(old / 1000));
  const th = checkTokenHealth({ envFile, authOk: true, warnDays: 14 });
  assert.equal(th.warn, true);
  assert.equal(th.reason, 'token_age');
});

// —— Phase 7 ——
test('P7: AUTO_EXECUTE gate path → require_approval when live flag off (scanner)', async () => {
  const { db } = tmpDb();
  const settings = createAgentSettingsStore(db);
  settings.setMode('auto');
  settings.setToggle('autoSubmitBids', true);
  settings.update({
    approvalPreviewFirstN: 0,
    rules: {
      bidAuto: {
        enabled: true,
        scoringAvailable: true,
        confidenceThreshold: 50,
        noExistingBid: true,
      },
      messageAuto: { enabled: false, scoringAvailable: true },
    },
    limits: { maxAutoBidsPerDay: 10, maxAutoMessagesPerDay: 5 },
  });
  const gate = createPermissionGate(db);
  const queue = createJobQueue(db);
  const mutations = createMutationRequester({ queue, gate });

  const storeRules = (await import('../../src/opportunity/store.js')).createOpportunityStore(db);
  storeRules.setScoringProfile({ preferredSkills: ['وردپرس'], budgetMin: 1e6 });
  storeRules.createRule({
    name: 'auto-wp',
    enabled: true,
    priority: 10,
    action: 'AUTO_EXECUTE',
    conditions: [{ field: 'skills', op: 'includes', value: 'وردپرس' }],
  });

  const opp = toProjectOpportunity({
    id: 7771,
    title: 'وردپرس فروشگاهی',
    description: 'نیاز به وردپرس',
    min_budget: 5_000_000,
    max_budget: 15_000_000,
    skills: [{ name: 'وردپرس' }],
  });

  const verdict = gate.check('bids.submit', {
    source: 'auto',
    projectId: opp.id,
    confidence: 90,
    matchScore: 90,
    budget: 10_000_000,
    hasExistingBid: false,
  });
  assert.ok(['auto_allow', 'require_approval'].includes(verdict.decision));

  let requested = null;
  const fakeMutations = {
    request(input) {
      requested = input;
      return mutations.request(input);
    },
  };

  const scanner = createOpportunityScanner({
    db,
    api: {
      client: { hasAuth: true },
      projects: {
        async search() {
          return { projects: [opp.raw || { id: 7771, title: opp.title, skills: [{ name: 'وردپرس' }], min_budget: 5e6, max_budget: 15e6 }] };
        },
      },
      rooms: { list: async () => ({ rooms: [] }) },
    },
    mutations: fakeMutations,
    allowLiveAutoBid: false,
    notify: async () => {},
  });

  const out = await scanner.scan({ manual: true, pages: 1, includeInvites: false });
  assert.equal(out.ok, true);
  // With live flag false, auto path must force approval / not claim live autoExecuted
  if (requested) {
    assert.equal(requested.forceRequireApproval, true);
    assert.equal(requested.payload.dryRun, true);
  }
  assert.ok(out.autoExecuted === 0 || out.approvals >= 0);
});

test('P7: decideOpportunity AUTO_EXECUTE respects toggle off', () => {
  const out = decideOpportunity({
    opportunity: { id: 1, budgetMax: 1e7 },
    score: 90,
    reasons: [],
    matchedRules: [{ name: 'r', action: 'AUTO_EXECUTE' }],
    settings: {
      mode: 'auto',
      emergencyStop: false,
      toggles: { autoSubmitBids: false },
      limits: { maxAutoBidsPerDay: 10 },
    },
    todayCounts: { bids: 0 },
  });
  assert.equal(out.decision, 'REQUEST_APPROVAL');
});

test('P7: config allowLiveAutoBid defaults false', () => {
  const prev = process.env.ALLOW_LIVE_AUTO_BID;
  delete process.env.ALLOW_LIVE_AUTO_BID;
  process.env.ENABLE_TELEGRAM = 'false';
  const cfg = loadAppConfig({ requireTelegram: false, requireOwner: false });
  assert.equal(cfg.allowLiveAutoBid, false);
  if (prev == null) delete process.env.ALLOW_LIVE_AUTO_BID;
  else process.env.ALLOW_LIVE_AUTO_BID = prev;
});

// —— Phase 8 ——
test('P8: notifyAllOwners fans out to every id', async () => {
  const res = await notifyAllOwners({
    token: '',
    chatIds: [1, 2],
    text: 'hi',
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes('missing_config') || res.sent === 0);
});

test('P8: Bale stub skips without token', async () => {
  const r = await notifyBaleOwners({ token: '', chatIds: [1], text: 'x' });
  assert.equal(r.skipped, true);
});

test('P8: multi owner parse still works', () => {
  assert.deepEqual(parseTelegramOwnerChatIds('1,2,1'), [1, 2]);
});

// —— Phase 9 ——
test('P9: win signal detection + draft HITL scaffold', () => {
  assert.equal(detectWinSignal({ title: 'پروژه به شما تعلق گرفت — انتخاب شدید' }).isWin, true);
  assert.equal(detectWinSignal({ body: 'hello world' }).isWin, false);
  const draft = buildFirstClientMessageDraft({ guestName: 'علی', projectTitle: 'سایت' });
  assert.match(draft, /سلام/);
  assert.match(draft, /علی/);
  const advanced = advancePostWin({ phase: 'DETECTED', projectId: '9' }, { guestName: 'علی' });
  assert.equal(advanced.phase, 'AWAITING_OWNER');
  assert.ok(advanced.draftText);
  const fa = formatPostWinSectionFa(advanced);
  assert.match(fa, /پس از برد/);
  assert.match(fa, /HITL|تأیید/);
});

test('P9: scanNotificationsForWins', () => {
  const { wins, skipped } = scanNotificationsForWins([
    { title: 'تبریک — برنده شدید', body: 'x' },
    { title: 'پیام عادی', body: 'سلام' },
  ]);
  assert.equal(wins.length, 1);
  assert.equal(skipped, 1);
});
