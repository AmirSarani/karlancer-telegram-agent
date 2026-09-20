/**
 * Liveness / readiness / detailed health (authenticated detail is caller responsibility).
 */
export function buildHealth({ db, worker, startedAt, version = '0.2.0' } = {}) {
  const now = Date.now();
  let dbOk = false;
  try {
    if (db) {
      db.prepare('SELECT 1 AS ok').get();
      dbOk = true;
    }
  } catch {
    dbOk = false;
  }

  const queueDepth = db
    ? db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running','waiting_for_approval','planning')`).get()?.c ?? 0
    : null;

  return {
    status: dbOk ? 'ok' : 'degraded',
    version,
    uptime_sec: startedAt ? Math.floor((now - startedAt) / 1000) : null,
    db: dbOk ? 'up' : 'down',
    worker: worker?.state || 'unknown',
    queue_depth: queueDepth,
    ts: new Date().toISOString(),
  };
}
