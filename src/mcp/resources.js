import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * MCP resources — tenant-safe projections + live API snapshots (redacted).
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ stateDir: string, root: string, api?: object, getTenantId?: () => string }} ctx
 */
export function registerResources(server, ctx) {
  const stateDir = path.resolve(ctx.stateDir);
  const root = path.resolve(ctx.root);
  const getTenantId = ctx.getTenantId || (() => 'default');

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

  function jsonResource(uri, mimeType, obj) {
    return {
      contents: [
        {
          uri,
          mimeType: mimeType || 'application/json',
          text: JSON.stringify(obj, null, 2),
        },
      ],
    };
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
    { description: 'API catalog / map', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://api-catalog',
          mimeType: 'text/markdown',
          text: (await readUnder(root, 'docs/KARLANCER_API_MAP.md')).startsWith('_(')
              ? await readUnder(root, 'docs/API_CATALOG.md')
              : await readUnder(root, 'docs/KARLANCER_API_MAP.md'),
        },
      ],
    })
  );

  // Live (auth) resources — normalized, tenant-tagged, no secrets
  server.resource(
    'profile',
    'karlancer://profile',
    { description: 'Authenticated profile/dashboard summary (normalized)', mimeType: 'application/json' },
    async () => {
      if (!ctx.api?.user) {
        return jsonResource('karlancer://profile', 'application/json', {
          tenantId: getTenantId(),
          status: 'api_unavailable',
        });
      }
      try {
        const me = await ctx.api.user.me();
        const { raw, ...safe } = me;
        return jsonResource('karlancer://profile', 'application/json', {
          tenantId: getTenantId(),
          ...safe,
        });
      } catch (e) {
        return jsonResource('karlancer://profile', 'application/json', {
          tenantId: getTenantId(),
          error: e.code || 'error',
          message: e.message,
        });
      }
    }
  );

  server.resource(
    'conversations',
    'karlancer://conversations',
    { description: 'First page of conversations (normalized)', mimeType: 'application/json' },
    async () => {
      if (!ctx.api?.rooms) {
        return jsonResource('karlancer://conversations', 'application/json', {
          tenantId: getTenantId(),
          status: 'api_unavailable',
        });
      }
      try {
        const data = await ctx.api.rooms.list({ page: 1 });
        return jsonResource('karlancer://conversations', 'application/json', {
          tenantId: getTenantId(),
          page: data.page,
          pagination: data.pagination,
          conversations: data.rooms.map(({ raw, ...r }) => r),
        });
      } catch (e) {
        return jsonResource('karlancer://conversations', 'application/json', {
          tenantId: getTenantId(),
          error: e.code || 'error',
          message: e.message,
        });
      }
    }
  );

  server.resource(
    'notifications',
    'karlancer://notifications',
    { description: 'Notifications page 1 (normalized)', mimeType: 'application/json' },
    async () => {
      if (!ctx.api?.notifications) {
        return jsonResource('karlancer://notifications', 'application/json', {
          tenantId: getTenantId(),
          status: 'api_unavailable',
        });
      }
      try {
        const data = await ctx.api.notifications.list({ page: 1 });
        return jsonResource('karlancer://notifications', 'application/json', {
          tenantId: getTenantId(),
          page: data.page,
          pagination: data.pagination,
          notifications: data.notifications.map(({ raw, ...n }) => n),
        });
      } catch (e) {
        return jsonResource('karlancer://notifications', 'application/json', {
          tenantId: getTenantId(),
          error: e.code || 'error',
          message: e.message,
        });
      }
    }
  );

  server.resource(
    'projects-map',
    'karlancer://projects',
    { description: 'Pointer to project search/get tools (no bulk scrape)', mimeType: 'text/markdown' },
    async () => ({
      contents: [
        {
          uri: 'karlancer://projects',
          mimeType: 'text/markdown',
          text: [
            '# Karlancer projects',
            '',
            'Use MCP tools (do not scrape):',
            '- `project.get` — by id/slug',
            '- `projects.search` — public search',
            '- `projects.suggest` — related projects',
            '',
            `tenant: ${getTenantId()}`,
          ].join('\n'),
        },
      ],
    })
  );
}
