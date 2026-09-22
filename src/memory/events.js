import crypto from 'node:crypto';
import { redactDeep } from '../security/redaction.js';

export function appendEvent(db, { jobId = null, tenantId = 'default', type, actor = 'system', payload = {} }) {
  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO events (event_id, job_id, tenant_id, type, actor, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId, jobId, tenantId, type, actor, JSON.stringify(redactDeep(payload)), createdAt);
  if (jobId) {
    db.prepare(`UPDATE jobs SET last_event_id = ?, updated_at = ? WHERE job_id = ?`).run(
      eventId,
      createdAt,
      jobId
    );
  }
  return { eventId, createdAt };
}

export function listEvents(db, { jobId, limit = 50 } = {}) {
  if (jobId) {
    return db
      .prepare(`SELECT * FROM events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(jobId, limit)
      .map(parseEvent);
  }
  return db
    .prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
    .map(parseEvent);
}

function parseEvent(row) {
  return {
    ...row,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
  };
}
