import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createJobQueue } from '../../src/worker/queue.js';
import { createPermissionGate } from '../../src/telegram/permission-gate.js';
import { createMutationRequester } from '../../src/telegram/mutation-request.js';
import { createAgentSettingsStore } from '../../src/telegram/agent-settings.js';
import {
  shouldAutoPrepareScanDrafts,
  clampScanPrepareMax,
  pickRoomsToPrepare,
  createScanPrepare,
  SCAN_PREPARE_DEFAULT_MAX,
  SCAN_PREPARE_HARD_MAX,
} from '../../src/agent/scan-prepare.js';
import {
  formatScanSummary,
  buildScanKeyboard,
  parseScanCallback,
  formatPrepareStatusLine,
} from '../../src/telegram/scan-ux.js';

test('shouldAutoPrepareScanDrafts: default prepare+HITL; skip only emergency', () => {
  assert.equal(shouldAutoPrepareScanDrafts({ mode: 'manual', chatAiMode: 'full_manual' }), true);
  assert.equal(shouldAutoPrepareScanDrafts({ mode: 'assisted', chatAiMode: 'full_manual' }), true);
  assert.equal(shouldAutoPrepareScanDrafts({ mode: 'auto', chatAiMode: 'full_auto' }), true);
  assert.equal(
    shouldAutoPrepareScanDrafts({ mode: 'assisted', chatAiMode: 'pick_to_answer', emergencyStop: true }),
    false
  );
});

test('clampScanPrepareMax respects hard cap', () => {
  assert.equal(clampScanPrepareMax(), SCAN_PREPARE_DEFAULT_MAX);
  assert.equal(clampScanPrepareMax(100), SCAN_PREPARE_HARD_MAX);
  assert.equal(clampScanPrepareMax(3), 3);
  assert.equal(clampScanPrepareMax(-1), SCAN_PREPARE_DEFAULT_MAX);
});

test('pickRoomsToPrepare prefers unread and merges matched', () => {
  const picked = pickRoomsToPrepare(
    [
      { roomId: '1', unread: 0, guest_name: 'A' },
      { roomId: '2', unread: 2, guest_name: 'B' },
      { roomId: '3', unread: 0, guest_name: 'C' },
    ],
    [{ roomId: '3', projectId: 99 }],
    2
  );
  assert.equal(picked.length, 2);
  assert.equal(picked[0].roomId, '2');
  assert.ok(picked.some((r) => r.roomId === '3' && r.keywordMatched));
});

test('prepareScanHits skips on emergency stop', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-sp-')), 't.sqlite'));
  createAgentSettingsStore(db).update({
    mode: 'assisted',
    chatAiMode: 'pick_to_answer',
    emergencyStop: true,
  });
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  const preparer = createScanPrepare({
    db,
    api: { messages: { list: async () => ({ messages: [] }) }, projects: {} },
    mutations,
    llm: null,
    queue,
  });
  const out = await preparer.prepareScanHits({
    priorityRooms: [{ roomId: '10', unread: 1, guest_name: 'X' }],
  });
  assert.equal(out.skipped, true);
  assert.equal(out.preparedCount, 0);
});

test('prepareScanHits queues messages.send HITL in assisted mode (no live send)', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-sp2-')), 't.sqlite'));
  createAgentSettingsStore(db).update({ mode: 'assisted', chatAiMode: 'full_manual' });
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });

  const api = {
    messages: {
      list: async () => ({
        messages: [
          { id: 1, text: 'سلام، برای پروژه نیاز به کمک دارم', isOwn: false, createdAt: new Date().toISOString() },
        ],
        roomMeta: { guestName: 'Mohammad.S' },
      }),
    },
    projects: {
      get: async () => ({ project: null }),
      getBySlug: async () => ({ project: null }),
    },
  };

  const preparer = createScanPrepare({ db, api, mutations, llm: null, queue });
  const out = await preparer.prepareScanHits({
    priorityRooms: [{ roomId: '724', unread: 1, guest_name: 'Mohammad.S', last_message: 'سلام' }],
    max: 1,
  });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, false);
  assert.ok(out.preparedCount >= 1, JSON.stringify(out));
  assert.ok(out.replyApprovals >= 1);
  const pending = queue.pendingApprovals();
  assert.ok(pending.length >= 1);
  assert.equal(pending[0].action || pending[0].goal, pending[0].action ? 'messages.send' : pending[0].action);
  // Ensure still pending (not auto-approved)
  assert.ok(pending.some((a) => {
    try {
      const p = JSON.parse(a.payload_json || '{}');
      return String(p.roomId) === '724';
    } catch {
      return false;
    }
  }));
});

test('prepareScanHits invite match also queues bid HITL', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-sp3-')), 't.sqlite'));
  createAgentSettingsStore(db).update({ mode: 'assisted' });
  const queue = createJobQueue(db);
  const gate = createPermissionGate(db);
  const mutations = createMutationRequester({ queue, gate });
  const api = {
    messages: {
      list: async () => ({
        messages: [{ id: 1, text: 'دعوت به همکاری', isOwn: false, projectId: 555 }],
        roomMeta: { guestName: 'Maryam.S' },
      }),
    },
    projects: {
      get: async (id) => ({
        project: {
          id,
          title: 'پروژه تست',
          minBudget: 2_000_000,
          maxBudget: 5_000_000,
          skills: ['node'],
        },
      }),
      getBySlug: async () => ({ project: null }),
    },
  };
  const preparer = createScanPrepare({ db, api, mutations, llm: null, queue });
  const out = await preparer.prepareScanHits({
    priorityRooms: [{ roomId: '88', unread: 0, guest_name: 'Maryam.S' }],
    matched: [{ roomId: '88', projectId: 555, inviteText: 'دعوت' }],
    max: 1,
  });
  assert.ok(out.bidApprovals >= 1, JSON.stringify(out));
  const bids = queue.pendingApprovals().filter((a) => a.action === 'bids.submit');
  assert.ok(bids.length >= 1);
});

test('scan UX shows prepare status and approvals deep link', () => {
  const summary = {
    pageCount: 10,
    unreadOnPage: 0,
    scannedAt: new Date().toISOString(),
    priorityRooms: [
      { guest_name: 'MohammadJavad.M', roomId: '1', unread: 0, last_message: 'فایل.png', reason: 'تطابق کلیدواژه' },
    ],
    preparedCount: 5,
    prepareMode: 'auto',
    analyzedCount: 5,
  };
  const text = formatScanSummary(summary);
  assert.match(text, /۵ مورد تحلیل شد|۵ مورد/);
  assert.match(text, /منتظر تأیید شما/);
  assert.equal(formatPrepareStatusLine(summary)?.includes('منتظر تأیید'), true);

  const kb = buildScanKeyboard(summary);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('goto:approvals'), JSON.stringify(data));
});

test('scan UX offers تحلیل همه in manual_offer mode', () => {
  const summary = {
    pageCount: 5,
    unreadOnPage: 0,
    scannedAt: new Date().toISOString(),
    priorityRooms: [{ guest_name: 'A', roomId: '1', unread: 0 }],
    preparedCount: 0,
    prepareMode: 'manual_offer',
  };
  const text = formatScanSummary(summary);
  assert.match(text, /تحلیل همه|پیش‌نویس آماده نیست/);
  const kb = buildScanKeyboard(summary);
  const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('scan:prepare'), JSON.stringify(data));
  assert.deepEqual(parseScanCallback('scan:prepare'), { type: 'scan_prepare' });
});
