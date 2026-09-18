import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Simple JSON-file conversation memory keyed by roomId (Karlancer room / chat id).
 * One file per room under MEMORY_DIR.
 */
export class RoomMemory {
  /**
   * @param {string} memoryDir
   */
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

  /**
   * @param {string|number} roomId
   * @returns {Promise<{ roomId: string, messages: Array<{role:string,content:string,ts:string}>, meta: object }>}
   */
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

  /**
   * @param {string|number} roomId
   * @param {{ messages?: Array, meta?: object }} data
   */
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

  /**
   * Append a chat turn and persist.
   * @param {string|number} roomId
   * @param {'user'|'assistant'|'system'} role
   * @param {string} content
   * @param {object} [extraMeta]
   */
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
