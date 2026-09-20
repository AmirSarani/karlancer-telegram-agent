import crypto from 'node:crypto';
import { redactDeep } from '../security/redaction.js';

export function memoryAppend(db, { tenantId = 'default', kind, refId = null, content, meta = {} }) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_items (id, tenant_id, kind, ref_id, content, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, kind, refId, String(content), JSON.stringify(redactDeep(meta)), createdAt);
  return { id, createdAt };
}

export function memorySearch(db, { tenantId = 'default', kind = null, q = '', limit = 20 } = {}) {
  let sql = `SELECT * FROM memory_items WHERE tenant_id = ?`;
  const params = [tenantId];
  if (kind) {
    sql += ` AND kind = ?`;
    params.push(kind);
  }
  if (q) {
    sql += ` AND content LIKE ?`;
    params.push(`%${q}%`);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map((r) => ({
    ...r,
    meta: r.meta_json ? JSON.parse(r.meta_json) : {},
  }));
}
