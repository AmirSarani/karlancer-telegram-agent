import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

/**
 * @param {object} ctx — db, queue, api, stateDir, root, worker?, getScopes?, getTenantId?
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

  // SDK 1.12.1 API is prompt(), not registerPrompt()
  server.prompt(
    'karlancer_analyze',
    'Short prompt for analyzing a Karlancer project (no secrets).',
    { title: z.string().optional().describe('Project title') },
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
