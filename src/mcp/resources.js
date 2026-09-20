import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ stateDir: string, root: string }} ctx
 */
export function registerResources(server, ctx) {
  const files = [
    ['karlancer://handoff', 'AGENT_HANDOFF.md', 'Latest agent handoff projection'],
    ['karlancer://project-state', 'PROJECT_STATE.md', 'Canonical project state projection'],
    ['karlancer://decisions', 'DECISIONS.md', 'Architecture decisions log'],
    ['karlancer://audit-doc', null, 'API-first audit (docs)'],
  ];

  server.registerResource(
    'handoff',
    'karlancer://handoff',
    { description: 'Latest AGENT_HANDOFF.md projection', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://handoff',
          mimeType: 'text/markdown',
          text: await readSafe(path.join(ctx.stateDir, 'AGENT_HANDOFF.md')),
        },
      ],
    })
  );

  server.registerResource(
    'project-state',
    'karlancer://project-state',
    { description: 'PROJECT_STATE.md projection', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://project-state',
          mimeType: 'text/markdown',
          text: await readSafe(path.join(ctx.stateDir, 'PROJECT_STATE.md')),
        },
      ],
    })
  );

  server.registerResource(
    'api-audit',
    'karlancer://api-audit',
    { description: 'Phase 0 API_FIRST_AUDIT.md', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://api-audit',
          mimeType: 'text/markdown',
          text: await readSafe(path.join(ctx.root, 'docs/API_FIRST_AUDIT.md')),
        },
      ],
    })
  );

  server.registerResource(
    'api-catalog',
    'karlancer://api-catalog',
    { description: 'API catalog', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://api-catalog',
          mimeType: 'text/markdown',
          text: await readSafe(path.join(ctx.root, 'docs/API_CATALOG.md')),
        },
      ],
    })
  );
}

async function readSafe(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return `_(missing projection: ${p})_`;
  }
}
