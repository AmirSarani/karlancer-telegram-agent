import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ stateDir: string, root: string }} ctx
 */
export function registerResources(server, ctx) {
  const stateDir = path.resolve(ctx.stateDir);
  const root = path.resolve(ctx.root);

  async function readUnder(base, rel) {
    const full = path.resolve(base, rel);
    if (!full.startsWith(base + path.sep) && full !== base) {
      return '_(path_traversal_blocked)_';
    }
    try {
      return await fs.readFile(full, 'utf8');
    } catch {
      return `_(missing projection: ${rel})_`;
    }
  }

  server.resource(
    'handoff',
    'karlancer://handoff',
    { description: 'Latest AGENT_HANDOFF.md projection', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://handoff',
          mimeType: 'text/markdown',
          text: await readUnder(stateDir, 'AGENT_HANDOFF.md'),
        },
      ],
    })
  );

  server.resource(
    'project-state',
    'karlancer://project-state',
    { description: 'PROJECT_STATE.md projection', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://project-state',
          mimeType: 'text/markdown',
          text: await readUnder(stateDir, 'PROJECT_STATE.md'),
        },
      ],
    })
  );

  server.resource(
    'api-audit',
    'karlancer://api-audit',
    { description: 'IMPLEMENTATION_AUDIT.md', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://api-audit',
          mimeType: 'text/markdown',
          text: await readUnder(root, 'docs/IMPLEMENTATION_AUDIT.md'),
        },
      ],
    })
  );

  server.resource(
    'api-catalog',
    'karlancer://api-catalog',
    { description: 'API catalog', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://api-catalog',
          mimeType: 'text/markdown',
          text: await readUnder(root, 'docs/API_CATALOG.md'),
        },
      ],
    })
  );
}
