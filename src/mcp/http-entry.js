/**
 * Streamable HTTP MCP + REST health/jobs for ops clients.
 * Auth before discovery; session bound to API key hash; anon never gets admin.
 */
import http from 'node:http';
import crypto, { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadAppConfig } from '../config.js';
import { openDb } from '../memory/db.js';
import { createJobQueue } from '../worker/queue.js';
import { createKarlancerApi } from '../api/adapters/index.js';
import { createMcpServer } from './create-server.js';
import { loadApiKeyRegistry, authorizeApiKey, hashApiKey } from '../security/auth.js';
import { buildHealth } from '../observability/health.js';
import { logger } from '../observability/logger.js';
import { RateLimiter } from '../api/rate-limit.js';
import { createLlmProvider, recordTokenUsage } from '../llm/provider.js';
import { TokenBudgetManager } from '../intelligence/token-budget.js';

const MAX_BODY = Number(process.env.MCP_MAX_BODY_BYTES || 256_000);
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 60_000);
const CORS_ORIGIN = process.env.MCP_CORS_ORIGIN || '';

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
const httpLimiter = new RateLimiter({ capacity: 60, refillPerSec: 20 });

const budget = new TokenBudgetManager({
  dailyTokenLimit: config.dailyTokenLimit,
  getUsage: () => {
    const day = new Date().toISOString().slice(0, 10);
    const row = db.prepare(`SELECT tokens FROM token_usage WHERE tenant_id = 'default' AND day = ?`).get(day);
    return { tokens: row?.tokens || 0 };
  },
});
const llm = createLlmProvider({
  apiKey: config.openaiApiKey,
  baseUrl: config.openaiBaseUrl,
  smallModel: config.openaiModel,
  onUsage: (u) => recordTokenUsage(db, u),
});

/** @type {Record<string, { transport: StreamableHTTPServerTransport, keyHash: string, scopes: string[] }>} */
const transports = {};

function getKey(req) {
  const h = req.headers['authorization'] || '';
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' ? x : '';
}

function authOrReject(req, res, scope = 'read') {
  // Anonymous: ONLY public health-level scopes — NEVER admin
  if (registry.size === 0 && process.env.MCP_ALLOW_ANON === 'true') {
    if (scope === 'admin' || scope === 'approve' || scope === 'write') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'anon_insufficient_scope' }));
      return null;
    }
    return { ok: true, scopes: ['read'], label: 'anon', keyHash: 'anon' };
  }
  const result = authorizeApiKey(registry, getKey(req), scope);
  if (!result.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.code }));
    return null;
  }
  return { ...result, keyHash: hashApiKey(getKey(req)) };
}

function setCors(res) {
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key, Mcp-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
}

async function readJsonLimited(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      const err = new Error('body_too_large');
      err.code = 'body_too_large';
      throw err;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function bindSession(sessionId, keyHash, scopes) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_sessions (session_id, api_key_hash, scopes_json, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).run(sessionId, keyHash, JSON.stringify(scopes), now, now);
}

function sessionAllowed(sessionId, keyHash) {
  const row = db.prepare(`SELECT * FROM mcp_sessions WHERE session_id = ?`).get(sessionId);
  if (!row) return false;
  return row.api_key_hash === keyHash;
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!httpLimiter.tryTake(1)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Public health — minimal, no secrets
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/health/detail' && req.method === 'GET') {
    if (!authOrReject(req, res, 'read')) return;
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
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_id' }));
      return;
    }
    const job = queue.get(id);
    res.writeHead(job ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job || { error: 'not_found' }));
    return;
  }

  if (url.pathname === '/mcp') {
    const auth = authOrReject(req, res, 'read');
    if (!auth) return;

    const watchdog = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request_timeout' }));
      }
    }, REQUEST_TIMEOUT_MS);

    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport;

      if (req.method === 'POST') {
        let body;
        try {
          body = await readJsonLimited(req);
        } catch (e) {
          res.writeHead(e.code === 'body_too_large' ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.code || 'bad_json' }));
          return;
        }

        if (sessionId && transports[sessionId]) {
          // Session must be bound to same credential
          if (!sessionAllowed(sessionId, auth.keyHash)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'session_credential_mismatch' }));
            return;
          }
          transport = transports[sessionId].transport;
          await transport.handleRequest(req, res, body);
          return;
        }
        if (!sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = { transport, keyHash: auth.keyHash, scopes: auth.scopes || ['read'] };
              bindSession(sid, auth.keyHash, auth.scopes || ['read']);
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) delete transports[sid];
            if (sid) db.prepare(`DELETE FROM mcp_sessions WHERE session_id = ?`).run(sid);
          };
          const mcp = createMcpServer({
            db,
            queue,
            api,
            llm,
            budget,
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
        if (!sessionAllowed(sessionId, auth.keyHash)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'session_credential_mismatch' }));
          return;
        }
        await transports[sessionId].transport.handleRequest(req, res);
        return;
      }
      res.writeHead(400).end('No session');
    } catch (e) {
      logger.error('mcp_http_error', { err: e.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    } finally {
      clearTimeout(watchdog);
    }
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(config.mcpHttpPort, config.mcpHttpHost, () => {
  logger.info('mcp_http_listen', { host: config.mcpHttpHost, port: config.mcpHttpPort });
});
