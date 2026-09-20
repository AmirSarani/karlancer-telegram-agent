/**
 * Durable scheduler — schedules survive restart (SQLite).
 */
import crypto from 'node:crypto';
import { logger } from '../observability/logger.js';

const DEFAULTS = [
  { name: 'rooms_scan', capability: 'rooms.scan', intervalMs: 5 * 60_000, payload: { page: 1 } },
  { name: 'messages_poll', capability: 'messages.poll', intervalMs: 2 * 60_000, payload: { page: 1 } },
  { name: 'health_refresh', capability: 'health.ping', intervalMs: 60_000, payload: {} },
  { name: 'reconcile_poll', capability: 'health.ping', intervalMs: 120_000, payload: { note: 'reconcile_tick' } },
];

/**
 * @param {{ db: import('better-sqlite3').Database, queue: ReturnType<import('./queue.js').createJobQueue> }} ctx
 */
export function createScheduler(ctx) {
  const { db, queue } = ctx;
  let timer = null;
  let stopped = false;
  /** @type {Set<string>} */
  const pausedCapabilities = new Set();
  let globalPause = false;

  function ensureDefaults() {
    const now = new Date().toISOString();
    for (const d of DEFAULTS) {
      const existing = db.prepare(`SELECT schedule_id FROM schedules WHERE name = ?`).get(d.name);
      if (existing) continue;
      db.prepare(
        `INSERT INTO schedules (
          schedule_id, tenant_id, name, capability, interval_ms, payload_json,
          enabled, paused, next_run_at, created_at, updated_at
        ) VALUES (?, 'default', ?, ?, ?, ?, 1, 0, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        d.name,
        d.capability,
        d.intervalMs,
        JSON.stringify(d.payload || {}),
        now,
        now,
        now
      );
    }
  }

  function pauseAll() {
    globalPause = true;
  }
  function resumeAll() {
    globalPause = false;
  }
  function pauseCapability(cap) {
    pausedCapabilities.add(cap);
  }
  function resumeCapability(cap) {
    pausedCapabilities.delete(cap);
  }

  function tick() {
    if (stopped || globalPause) return;
    const nowIso = new Date().toISOString();
    const due = db
      .prepare(
        `SELECT * FROM schedules WHERE enabled = 1 AND paused = 0 AND (next_run_at IS NULL OR next_run_at <= ?)`
      )
      .all(nowIso);
    for (const s of due) {
      if (pausedCapabilities.has(s.capability)) continue;
      try {
        queue.create({
          goal: s.capability,
          payload: s.payload_json ? JSON.parse(s.payload_json) : {},
          requestedBy: 'scheduler',
          idempotencyKey: `sched:${s.schedule_id}:${nowIso.slice(0, 16)}`,
          priority: 200,
        });
        const next = new Date(Date.now() + s.interval_ms).toISOString();
        db.prepare(
          `UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE schedule_id = ?`
        ).run(nowIso, next, nowIso, s.schedule_id);
      } catch (e) {
        logger.warn('scheduler_tick_error', { name: s.name, err: e.message });
      }
    }
  }

  return {
    ensureDefaults,
    pauseAll,
    resumeAll,
    pauseCapability,
    resumeCapability,
    tick,
    start(pollMs = 5_000) {
      stopped = false;
      timer = setInterval(() => tick(), pollMs);
      if (typeof timer.unref === 'function') timer.unref();
      tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    list() {
      return db.prepare(`SELECT * FROM schedules ORDER BY name`).all();
    },
  };
}

export default createScheduler;
