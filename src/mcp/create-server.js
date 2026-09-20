import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

/**
 * @param {object} ctx — db, queue, api, stateDir, root, worker?, getScopes?
 */
export function createMcpServer(ctx) {
  const server = new McpServer(
    { name: 'karlancer-mcp', version: '0.2.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        'Karlancer API-first agent. Prefer read tools; mutations go through *_plan + approvals. Never send secrets. Playwright is not used.',
    }
  );

  registerTools(server, ctx);
  registerResources(server, ctx);

  server.registerPrompt(
    'karlancer_analyze',
    {
      description: 'Short prompt for analyzing a Karlancer project (no secrets).',
      argsSchema: {
        title: { type: 'string', description: 'Project title', required: false },
      },
    },
    async ({ title }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze Karlancer project${title ? `: ${title}` : ''}. Be honest about Iran/mobile constraints. Output structured JSON fields only. Do not invent APIs.`,
          },
        },
      ],
    })
  );

  return server;
}
