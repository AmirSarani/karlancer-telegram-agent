/**
 * Streamable HTTP MCP + REST health/jobs for ops clients.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadAppConfig } from '../config.js';
import { openDb } from '../memory/db.js';
import { createJobQueue } from '../worker/queue.js';
import { createKarlancerApi } from '../api/adapters/index.js';
import { createMcpServer } from './create-server.js';
import { loadApiKeyRegistry, authorizeApiKey } from '../security/auth.js';
import { buildHealth } from '../observability/health.js';
import { logger } from '../observability/logger.js';

const config = loadAppConfig({ requireTelegram: false });
const db = openDb(config.dbPath);
const queue = createJobQueue(db);
const api = createKarlancerApi({
  baseUrl: config.karlancerBaseUrl,
  accessToken: config.karlancerAccessToken,
  cookie: config.karlancerCookie,
  timeoutMs: config.karlancerTimeoutMs,
});
const registry = loadApiKeyRegistry(process.env);
const startedAt = Date.now();

/** @type {Record<string, StreamableHTTPServerTransport>} */
const transports = {};

function getKey(req) {
  const h = req.headers['authorization'] || '';
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' ? x : '';
}

function authOrReject(req, res, scope = 'read') {
  if (registry.size === 0 && process.env.MCP_ALLOW_ANON === 'true') {
    return { ok: true, scopes: ['admin'] };
  }
  const result = authorizeApiKey(registry, getKey(req), scope);
  if (!result.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.code }));
    return null;
  }
  return result;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildHealth({ db, startedAt })));
    return;
  }

  if (url.pathname === '/jobs' && req.method === 'GET') {
    if (!authOrReject(req, res, 'read')) return;
    const status = url.searchParams.get('status');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobs: queue.list({ status, limit: 50 }) }));
    return;
  }

  if (url.pathname.startsWith('/jobs/') && req.method === 'GET') {
    if (!authOrReject(req, res, 'read')) return;
    const id = url.pathname.split('/')[2];
    const job = queue.get(id);
    res.writeHead(job ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job || { error: 'not_found' }));
    return;
  }

  if (url.pathname === '/mcp') {
    const auth = authOrReject(req, res, 'read');
    if (!auth) return;

    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport;

      if (req.method === 'POST') {
        const body = await readJson(req);
        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
          await transport.handleRequest(req, res, body);
          return;
        }
        if (!sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport;
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) delete transports[sid];
          };
          const mcp = createMcpServer({
            db,
            queue,
            api,
            stateDir: config.stateDir,
            root: config.root,
            startedAt,
            getScopes: () => auth.scopes || ['read'],
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_session' }));
        return;
      }

      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res);
        return;
      }
      res.writeHead(400).end('No session');
    } catch (e) {
      logger.error('mcp_http_error', { err: e.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(config.mcpHttpPort, config.mcpHttpHost, () => {
  logger.info('mcp_http_listen', { host: config.mcpHttpHost, port: config.mcpHttpPort });
});
