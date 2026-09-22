import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import {
  BTN,
  mainMenuKeyboard,
  parseCallbackData,
  mapMenuText,
  formatHelp,
  formatSettingsCard,
  homeInlineKeyboard,
} from '../../src/telegram/ui.js';
import {
  CP,
  parseControlCallback,
  controlHubKeyboard,
  eyesMenuKeyboard,
  handsMenuKeyboard,
  formatControlHub,
  formatSystemOverview,
  formatLiveAutoCard,
  formatLiveAutoWarningConfirm,
  formatAuditCards,
  formatDashboardSummary,
  formatSeoMetaCard,
  formatControlHelp,
  collectSystemOverview,
} from '../../src/telegram/control-panel.js';
import {
  readLiveAutoBidFlag,
  writeLiveAutoBidFlag,
  createLiveAutoBidRef,
} from '../../src/telegram/live-auto-flag.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  return openDb(path.join(dir, 't.sqlite'));
}

test('main menu includes کنترل سیستم; max 2 buttons/row', () => {
  const rows = mainMenuKeyboard().keyboard;
  for (const row of rows) assert.ok(row.length <= 2);
  const labels = rows.flat().map((b) => b.text);
  assert.ok(labels.includes(BTN.CONTROL));
  assert.equal(mapMenuText(BTN.CONTROL), 'control');
  assert.ok(labels.includes(BTN.SETTINGS));
  assert.ok(labels.includes(BTN.HELP));
});

test('home inline includes control hub; ≤2 per row', () => {
  const home = homeInlineKeyboard().inline_keyboard;
  for (const row of home) assert.ok(row.length <= 2);
  const data = home.flat().map((b) => b.callback_data);
  assert.ok(data.includes('cp:hub'));
});

test('control hub keyboard IA sections', () => {
  const kb = controlHubKeyboard().inline_keyboard;
  for (const row of kb) assert.ok(row.length <= 2);
  const data = kb.flat().map((b) => b.callback_data);
  assert.ok(data.includes(CP.SYS));
  assert.ok(data.includes(CP.EYES));
  assert.ok(data.includes(CP.BRAIN));
  assert.ok(data.includes(CP.HANDS));
  assert.ok(data.includes(CP.SEC));
  assert.ok(data.includes(CP.NOTIF));
  assert.ok(data.includes(CP.AUDIT));
  assert.match(formatControlHub(), /کنترل سیستم/);
});

test('parse control callbacks via ui + control-panel', () => {
  assert.deepEqual(parseCallbackData('cp:hub'), { type: 'cp_hub' });
  assert.deepEqual(parseCallbackData('eyes:dash'), { type: 'eyes_dash' });
  assert.deepEqual(parseCallbackData('hands:live:on'), { type: 'hands_live_on' });
  assert.deepEqual(parseCallbackData('notif:digest'), { type: 'notif_digest' });
  assert.deepEqual(parseCallbackData('wiz:limits'), { type: 'wiz_limits' });
  assert.deepEqual(parseControlCallback('cp:eyes'), { type: 'cp_eyes' });
  assert.equal(parseControlCallback('nav:home'), null);
});

test('eyes/hands keyboards progressive disclosure', () => {
  const eyes = eyesMenuKeyboard().inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(eyes.includes(CP.EYES_DASH));
  assert.ok(eyes.includes(CP.EYES_SEARCH));
  assert.ok(eyes.includes(CP.EYES_SEO));
  const hands = handsMenuKeyboard(false).inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(hands.includes(CP.HANDS_LIVE));
  assert.ok(hands.includes(CP.HANDS_LIMITS));
  assert.ok(hands.includes(CP.HANDS_BL));
});

test('live auto flag defaults false; kv override + hot reload', () => {
  const db = tmpDb();
  assert.equal(readLiveAutoBidFlag(db, { envDefault: false }), false);
  const ref = createLiveAutoBidRef(false);
  let seen = null;
  const res = writeLiveAutoBidFlag(db, true, {
    syncEnv: false,
    onChange: (v) => {
      seen = v;
      ref.set(v);
    },
  });
  assert.equal(res.enabled, true);
  assert.equal(seen, true);
  assert.equal(ref.get(), true);
  assert.equal(readLiveAutoBidFlag(db, { envDefault: false }), true);
  writeLiveAutoBidFlag(db, false, { syncEnv: false, onChange: (v) => ref.set(v) });
  assert.equal(ref.get(), false);
});

test('Persian cards have structure and no secrets jargon dumps', () => {
  const sys = formatSystemOverview({
    state: 'running',
    karlancerAuth: true,
    executionMode: 'manual',
    liveAutoBid: false,
    contracts: [],
    ownerIds: [1366010187],
    mcpHost: '127.0.0.1',
    mcpPort: 8787,
    mcpApiKeySet: false,
    baleConfigured: false,
    autoToday: { messages: 0, bids: 0 },
  });
  assert.match(sys, /نمای سیستم/);
  assert.match(sys, /پیشنهاد زنده/);
  assert.doesNotMatch(sys, /Bearer|Authorization|password/i);
  assert.match(formatLiveAutoCard(false), /خاموش/);
  assert.match(formatLiveAutoWarningConfirm(), /هشدار|مطمئن/);
  assert.match(formatDashboardSummary({ user: { name: 'تست' }, wallet: {} }), /داشبورد/);
  assert.match(formatSeoMetaCard({ name: 'a.webp', pathHint: '/api/file/seoContents/a.webp' }), /SEO/);
  assert.match(formatAuditCards([]), /تاریخچه/);
  assert.match(formatControlHelp(), /نقشه/);
  assert.match(formatHelp(), /کنترل سیستم/);
  assert.match(
    formatSettingsCard({ state: 'running', executionMode: 'manual', toggles: {}, liveAutoBid: false }),
    /پیشنهاد زنده/
  );
});

test('collectSystemOverview lists contracts without secrets', () => {
  const db = tmpDb();
  const snap = collectSystemOverview({
    db,
    api: { client: { hasAuth: true } },
    runtime: { state: 'running' },
    owners: [1, 2],
    mcpHost: '127.0.0.1',
    mcpPort: 8787,
    mcpApiKeySet: true,
    baleConfigured: false,
    envDefaultLive: false,
  });
  assert.equal(snap.liveAutoBid, false);
  assert.deepEqual(snap.ownerIds, [1, 2]);
  assert.ok(Array.isArray(snap.contracts));
  assert.equal(snap.mcpApiKeySet, true);
});
