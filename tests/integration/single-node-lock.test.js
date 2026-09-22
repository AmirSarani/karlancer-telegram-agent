/**
 * Single-node lock: live holder cannot be stolen while heartbeats stay fresh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, acquireSingleNodeLock } from '../../src/memory/db.js';

test('live process lock cannot be stolen after stale window while heartbeating', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-lock-')), 'l.sqlite'));
  const staleMs = 200; // stand-in for production 120_000
  const lock = acquireSingleNodeLock(db, 'holder-a', 'sqlite_primary', { staleMs, heartbeatMs: 50 });
  lock.startHeartbeat();

  await new Promise((r) => setTimeout(r, 500));

  assert.throws(
    () => acquireSingleNodeLock(db, 'holder-b', 'sqlite_primary', { staleMs, heartbeatMs: 50 }),
    (err) => err && err.code === 'single_node_lock_held'
  );

  lock.release();

  const lock2 = acquireSingleNodeLock(db, 'holder-b', 'sqlite_primary', { staleMs, heartbeatMs: 50 });
  assert.ok(lock2);
  lock2.release();
});

test('stale lock without heartbeat can be reclaimed after staleMs', async () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-lock2-')), 'l.sqlite'));
  const staleMs = 100;
  acquireSingleNodeLock(db, 'holder-a', 'sqlite_primary', { staleMs, heartbeatMs: 60_000 });
  await new Promise((r) => setTimeout(r, 150));
  const lock2 = acquireSingleNodeLock(db, 'holder-b', 'sqlite_primary', { staleMs, heartbeatMs: 60_000 });
  assert.ok(lock2);
  lock2.release();
});
