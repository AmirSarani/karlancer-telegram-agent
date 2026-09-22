import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScanNotifyFingerprint,
  isEmptyScanSummary,
  shouldNotifyScanSummary,
  readLastScanNotifyFingerprint,
  writeLastScanNotifyFingerprint,
  SCAN_NOTIFY_FP_KV_KEY,
} from '../../src/telegram/scan-notify-dedupe.js';
import { openDb } from '../../src/memory/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sampleRooms = [
  {
    guest_name: 'MohammadJavad.M',
    roomId: '100',
    unread: 0,
    last_message: 'سلام',
  },
  {
    guest_name: 'Mohammad.S',
    roomId: '200',
    unread: 0,
    last_message: 'ممنون',
  },
  {
    guest_name: 'Maryam.S',
    roomId: '300',
    unread: 0,
    last_message: 'اوکی',
  },
];

function summary(overrides = {}) {
  return {
    page: 1,
    pageCount: 10,
    unreadOnPage: 0,
    priorityRooms: sampleRooms,
    matched: [],
    preparedCount: 0,
    scannedAt: new Date().toISOString(),
    scanTrigger: 'scheduled',
    ...overrides,
  };
}

test('fingerprint stable for same priority room set (order-independent)', () => {
  const a = buildScanNotifyFingerprint(summary());
  const b = buildScanNotifyFingerprint(
    summary({
      priorityRooms: [...sampleRooms].reverse(),
      scannedAt: '2099-01-01T00:00:00.000Z',
    })
  );
  assert.equal(a, b);
  assert.match(a, /^v1\|/);
});

test('fingerprint changes when a new room enters priority set', () => {
  const a = buildScanNotifyFingerprint(summary());
  const b = buildScanNotifyFingerprint(
    summary({
      priorityRooms: [
        ...sampleRooms,
        { roomId: '999', unread: 1, last_message: 'پیام تازه', guest_name: 'New' },
      ],
      unreadOnPage: 1,
    })
  );
  assert.notEqual(a, b);
});

test('fingerprint changes when unread / message watermark changes', () => {
  const a = buildScanNotifyFingerprint(summary());
  const b = buildScanNotifyFingerprint(
    summary({
      priorityRooms: sampleRooms.map((r, i) =>
        i === 0 ? { ...r, unread: 2, last_message: 'پیام جدید واقعی' } : r
      ),
      unreadOnPage: 1,
    })
  );
  assert.notEqual(a, b);
});

test('auto unchanged → silent (no spam)', () => {
  const s = summary({ prepareMode: 'auto', preparedCount: 0 });
  const fp = buildScanNotifyFingerprint(s);
  const d = shouldNotifyScanSummary(s, { lastFingerprint: fp });
  assert.equal(d.notify, false);
  assert.equal(d.reason, 'unchanged');
});

test('auto with «قبلاً در صف» (preparedCount 0, same rooms) → silent', () => {
  const s = summary({
    prepareMode: 'auto',
    preparedCount: 0,
    analyzedCount: 3,
  });
  const fp = buildScanNotifyFingerprint(s);
  const d = shouldNotifyScanSummary(s, { lastFingerprint: fp });
  assert.equal(d.notify, false);
  assert.equal(d.reason, 'unchanged');
});

test('new room on auto → notify', () => {
  const prev = summary();
  const next = summary({
    priorityRooms: [
      ...sampleRooms,
      { roomId: '777', unread: 1, last_message: 'hello', guest_name: 'X' },
    ],
    unreadOnPage: 1,
  });
  const d = shouldNotifyScanSummary(next, {
    lastFingerprint: buildScanNotifyFingerprint(prev),
  });
  assert.equal(d.notify, true);
  assert.equal(d.reason, 'changed');
});

test('manual scan / forceNotify always shows even if fingerprint unchanged', () => {
  const s = summary({ scanTrigger: 'manual', forceNotify: true });
  const fp = buildScanNotifyFingerprint(s);
  const d = shouldNotifyScanSummary(s, { lastFingerprint: fp });
  assert.equal(d.notify, true);
  assert.equal(d.reason, 'manual_or_ui');
});

test('pending UI (تازه‌سازی loading card) always notifies', () => {
  const s = summary();
  const fp = buildScanNotifyFingerprint(s);
  const d = shouldNotifyScanSummary(s, { lastFingerprint: fp, hasPendingUi: true });
  assert.equal(d.notify, true);
  assert.equal(d.reason, 'manual_or_ui');
});

test('first auto with items → notify once', () => {
  const d = shouldNotifyScanSummary(summary(), { lastFingerprint: null });
  assert.equal(d.notify, true);
  assert.equal(d.reason, 'first');
  assert.equal(d.persist, true);
});

test('first auto empty → quiet but persist fingerprint', () => {
  const s = summary({ priorityRooms: [], unreadOnPage: 0, matched: [] });
  assert.equal(isEmptyScanSummary(s), true);
  const d = shouldNotifyScanSummary(s, { lastFingerprint: null });
  assert.equal(d.notify, false);
  assert.equal(d.reason, 'empty_bootstrap');
  assert.equal(d.persist, true);
});

test('new prepares on same rooms still notify once', () => {
  const s = summary({ preparedCount: 2, prepareMode: 'auto' });
  const fp = buildScanNotifyFingerprint(s);
  const d = shouldNotifyScanSummary(s, { lastFingerprint: fp });
  assert.equal(d.notify, true);
  assert.equal(d.reason, 'new_prepares');
});

test('SQLite kv persists last notified fingerprint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-fp-'));
  const dbPath = path.join(dir, 't.sqlite');
  const db = openDb(dbPath);
  assert.equal(readLastScanNotifyFingerprint(db), null);
  writeLastScanNotifyFingerprint(db, 'v1|test');
  assert.equal(readLastScanNotifyFingerprint(db), 'v1|test');
  const row = db.prepare(`SELECT key FROM kv WHERE key = ?`).get(SCAN_NOTIFY_FP_KV_KEY);
  assert.equal(row.key, SCAN_NOTIFY_FP_KV_KEY);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
