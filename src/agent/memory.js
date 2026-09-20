import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Legacy JSON-file conversation memory (projection helper).
 * Prefer SQLite memory_items for new code.
 */
export class RoomMemory {
  constructor(memoryDir) {
    this.memoryDir = memoryDir;
  }

  filePath(roomId) {
    const safe = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.memoryDir, `${safe}.json`);
  }

  async ensureDir() {
    await fs.mkdir(this.memoryDir, { recursive: true });
  }

  async load(roomId) {
    await this.ensureDir();
    const fp = this.filePath(roomId);
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const data = JSON.parse(raw);
      return {
        roomId: String(roomId),
        messages: Array.isArray(data.messages) ? data.messages : [],
        meta: data.meta && typeof data.meta === 'object' ? data.meta : {},
      };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { roomId: String(roomId), messages: [], meta: {} };
      }
      throw err;
    }
  }

  async save(roomId, data) {
    await this.ensureDir();
    const fp = this.filePath(roomId);
    const payload = {
      roomId: String(roomId),
      messages: data.messages || [],
      meta: data.meta || {},
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(fp, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  }

  async append(roomId, role, content, extraMeta = {}) {
    const state = await this.load(roomId);
    state.messages.push({
      role,
      content: String(content),
      ts: new Date().toISOString(),
    });
    state.meta = { ...state.meta, ...extraMeta };
    return this.save(roomId, state);
  }

  async clear(roomId) {
    await this.ensureDir();
    const fp = this.filePath(roomId);
    try {
      await fs.unlink(fp);
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
  }
}

export default RoomMemory;
