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

function escapeLike(q) {
  return String(q).replace(/([%_\\])/g, '\\$1').slice(0, 200);
}

export function memorySearch(db, { tenantId = 'default', kind = null, q = '', limit = 20 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  let sql = `SELECT * FROM memory_items WHERE tenant_id = ?`;
  const params = [tenantId];
  if (kind) {
    sql += ` AND kind = ?`;
    params.push(String(kind).slice(0, 64));
  }
  if (q) {
    sql += ` AND content LIKE ? ESCAPE '\\'`;
    params.push(`%${escapeLike(q)}%`);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(lim);
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      ...r,
      meta: r.meta_json ? JSON.parse(r.meta_json) : {},
    }));
}
