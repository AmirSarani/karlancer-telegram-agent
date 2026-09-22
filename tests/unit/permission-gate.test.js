import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import {
  createAgentSettingsStore,
  defaultAgentSettings,
  normalizeAgentSettings,
} from '../../src/telegram/agent-settings.js';
import { createPermissionGate } from '../../src/telegram/permission-gate.js';
import { createMutationRequester } from '../../src/telegram/mutation-request.js';
import {
  formatSettingsCard,
  formatApprovalDetail,
  parseCallbackData,
  BOT_COMMANDS,
  settingsInlineKeyboard,
} from '../../src/telegram/ui.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gate-'));
  const dbPath = path.join(dir, 't.sqlite');
  const db = openDb(dbPath);
  return { db, dir, dbPath };
}

test('default settings are Manual with auto toggles OFF', () => {
  const d = defaultAgentSettings();
  assert.equal(d.mode, 'manual');
  assert.equal(d.emergencyStop, false);
  assert.equal(d.toggles.autoReplyMessages, false);
  assert.equal(d.toggles.autoSubmitBids, false);
  assert.equal(d.toggles.autoMarkNotificationsRead, false);
  assert.equal(d.rules.messageAuto.enabled, false);
  assert.equal(d.rules.bidAuto.enabled, false);
  assert.equal(d.limits.maxAutoMessagesPerDay, 5);
  assert.equal(d.limits.maxAutoBidsPerDay, 10);
});

test('settings persist in SQLite kv and normalize unknowns', () => {
  const { db } = tmpDb();
  const store = createAgentSettingsStore(db);
  assert.equal(store.get().mode, 'manual');
  store.setMode('assisted');
  store.setToggle('autoMarkNotificationsRead', true);
  const again = createAgentSettingsStore(db).get();
  assert.equal(again.mode, 'assisted');
  assert.equal(again.toggles.autoMarkNotificationsRead, true);
  const bad = normalizeAgentSettings({ mode: 'hacked', toggles: { autoReplyMessages: 1 } });
  assert.equal(bad.mode, 'manual');
  assert.equal(bad.toggles.autoReplyMessages, true);
});

test('PermissionGate Manual requires approval for send/bid', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  const send = gate.check('messages.send', { text: 'hi', roomId: '1' });
  assert.equal(send.decision, 'require_approval');
  assert.equal(send.reason, 'manual_mode');
  const bid = gate.check('bids.submit', { projectId: '9' });
  assert.equal(bid.decision, 'require_approval');
});

test('Assisted allows low-risk mark_read when toggle ON; send still approval', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  gate.settings.setMode('assisted');
  gate.settings.setToggle('autoMarkNotificationsRead', true);
  const read = gate.check('notifications.mark_read', {});
  assert.equal(read.decision, 'auto_allow');
  const send = gate.check('messages.send', { roomId: '1', text: 'x' });
  assert.equal(send.decision, 'require_approval');
  assert.equal(send.reason, 'assisted_high_risk');
});

test('Auto requires matching rule + toggle; otherwise approval', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  gate.settings.setMode('auto');
  gate.settings.setToggle('autoReplyMessages', true);
  // rule still disabled / unconfigured
  let v = gate.check('messages.send', { roomId: '1', text: 'سلام دعوت' });
  assert.equal(v.decision, 'require_approval');
  assert.ok(['rule_message_disabled', 'rule_not_configured'].includes(v.reason) || v.reason.startsWith('rule_'));

  gate.settings.update({
    approvalPreviewFirstN: 0,
    rules: {
      messageAuto: {
        enabled: true,
        keywords: ['دعوت'],
        scoringAvailable: false,
        matchScoreThreshold: null,
      },
    },
  });
  v = gate.check('messages.send', { roomId: '1', text: 'سلام دعوت همکاری', riskHint: 'low' });
  assert.equal(v.decision, 'auto_allow');
  assert.equal(v.matchedRule, 'messageAuto');
  assert.equal(v.reason, 'auto_rule_matched');

  // disable toggle → approval
  gate.settings.setToggle('autoReplyMessages', false);
  v = gate.check('messages.send', { roomId: '1', text: 'دعوت' });
  assert.equal(v.reason, 'toggle_off_auto_reply');
});

test('emergency stop disables auto toggles and forces manual', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  gate.settings.setMode('auto');
  gate.settings.setToggle('autoSubmitBids', true);
  const s = gate.emergencyStop();
  assert.equal(s.emergencyStop, true);
  assert.equal(s.mode, 'manual');
  assert.equal(s.toggles.autoSubmitBids, false);
  const v = gate.check('bids.submit', { projectId: '1' });
  assert.equal(v.decision, 'require_approval');
  assert.equal(v.reason, 'emergency_stop');
});

test('blacklist denies contact', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  gate.settings.update({ blacklist: { rooms: ['99'], users: [], keywords: ['اسپم'] } });
  assert.equal(gate.check('messages.send', { roomId: '99', text: 'hi' }).decision, 'deny');
  assert.equal(gate.check('messages.send', { roomId: '1', text: 'این اسپم است' }).decision, 'deny');
});

test('daily limits block further auto', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  gate.settings.setMode('auto');
  gate.settings.setToggle('autoReplyMessages', true);
  gate.settings.update({
    approvalPreviewFirstN: 0,
    autoShowCardWhenRiskMediumPlus: false,
    limits: { maxAutoMessagesPerDay: 1 },
    rules: {
      messageAuto: { enabled: true, keywords: ['ok'], scoringAvailable: false },
    },
  });
  // simulate one auto audit
  gate.recordDecision(
    'messages.send',
    { decision: 'auto_allow', reason: 'auto_rule_matched', reasonFa: 'x', mode: 'auto', risk: 'low', matchedRule: 'messageAuto' },
    { approvedBy: 'auto' }
  );
  const v = gate.check('messages.send', { roomId: '1', text: 'ok message', riskHint: 'low' });
  assert.equal(v.reason, 'daily_limit_messages');
});

test('owner_confirm bypasses mode but still respects blacklist', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  const ok = gate.check('messages.send', { source: 'owner_confirm', roomId: '1', text: 'hi' });
  assert.equal(ok.decision, 'auto_allow');
  assert.equal(ok.reason, 'owner_confirm');
  gate.settings.update({ blacklist: { rooms: ['1'], users: [], keywords: [] } });
  assert.equal(
    gate.check('messages.send', { source: 'owner_confirm', roomId: '1', text: 'hi' }).decision,
    'deny'
  );
});

test('mutation requester auto-approves only when gate auto_allow', () => {
  const { db } = tmpDb();
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mut = createMutationRequester({ queue, gate });

  // Manual → pending approval
  const pending = mut.request({
    action: 'messages.send',
    payload: { roomId: '7', text: 'draft' },
    gateCtx: { roomId: '7', text: 'draft' },
    requestedBy: 'test',
  });
  assert.equal(pending.ok, true);
  assert.equal(pending.pendingApproval, true);
  assert.equal(queue.getApproval(pending.approval.approval_id).status, 'pending');

  // Owner confirm → approved
  const owned = mut.request({
    action: 'messages.send',
    payload: { roomId: '8', text: 'draft2' },
    gateCtx: { source: 'owner_confirm', roomId: '8', text: 'draft2' },
    requestedBy: 'telegram:1',
    idempotencyKey: 'own-8',
  });
  assert.equal(owned.ownerConfirmed, true);
  assert.equal(owned.approval.status, 'approved');
});

test('auto bid requires configured rule — stubs stay OFF', () => {
  const { db } = tmpDb();
  const gate = createPermissionGate(db);
  gate.settings.setMode('auto');
  gate.settings.setToggle('autoSubmitBids', true);
  gate.settings.update({
    rules: { bidAuto: { enabled: true, categoryMatch: [], scoringAvailable: false } },
  });
  const v = gate.check('bids.submit', { projectId: '1', budget: 100 });
  assert.equal(v.decision, 'require_approval');
  assert.equal(v.reason, 'rule_not_configured');
});

test('UX: settings/commands/approval detail avoid technical jargon', () => {
  const card = formatSettingsCard({
    state: 'running',
    executionMode: 'manual',
    toggles: {},
  });
  assert.doesNotMatch(card, /Mutation|Endpoint|API\b/i);
  assert.match(card, /دستی|عملیات|قانون/);
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'mode'));
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'emergency_stop'));
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'show_rules'));
  const data = settingsInlineKeyboard('running').inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('mode:manual'));
  assert.ok(data.includes('set:emerg'));
  assert.ok(data.includes('nav:rules'));
  assert.deepEqual(parseCallbackData('mode:assisted'), { type: 'set_mode', mode: 'assisted' });

  const detail = formatApprovalDetail({
    approval_id: '123e4567-e89b-12d3-a456-426614174000',
    action: 'messages.send',
    created_at: new Date().toISOString(),
    payload_json: JSON.stringify({
      roomId: 'r1',
      text: 'پیش‌نویس',
      aiReason: 'پاسخ حرفه‌ای',
      risk: 'high',
    }),
  });
  assert.match(detail, /عملیات/);
  assert.match(detail, /مقصد/);
  assert.match(detail, /دلیل AI/);
  assert.match(detail, /ریسک/);
  assert.match(detail, /پیش‌نمایش/);
  assert.doesNotMatch(detail, /Mutation|payload_hash/i);
});
