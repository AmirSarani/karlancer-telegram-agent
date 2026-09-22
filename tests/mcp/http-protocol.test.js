/**
 * MCP HTTP protocol: public health, auth failure, body limit,
 * initialize + tools/list with valid key, session credential mismatch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for server');
}

function spawnHttp(envExtra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-http-'));
  const port = 18787 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    DB_PATH: path.join(tmp, 'a.sqlite'),
    STATE_DIR: path.join(tmp, 'state'),
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: String(port),
    MCP_API_KEY: 'test-secret-key',
    MCP_ALLOW_ANON: 'false',
    MCP_MAX_BODY_BYTES: '1024',
    ENABLE_TELEGRAM: 'false',
    ...envExtra,
  };
  let log = '';
  const child = spawn(process.execPath, [path.join(root, 'src/mcp/http-entry.js')], {
    env,
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { log += d.toString(); });
  child.stdout.on('data', (d) => { log += d.toString(); });
  return { child, port, tmp, getLog: () => log };
}

test('MCP HTTP: public health, auth failure on /mcp, body limit', async () => {
  const { child, port, getLog } = spawnHttp();
  try {
    await waitFor(async () => {
      try { return (await request(port, 'GET', '/health')).status === 200; } catch { return false; }
    }, 10000);
    const health = await request(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).status, 'ok');

    const unauth = await request(port, 'POST', '/mcp', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    assert.equal(unauth.status, 401);

    const big = 'x'.repeat(2000);
    const oversized = await request(port, 'POST', '/mcp', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-key' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: big } }),
    });
    assert.equal(oversized.status, 413);
  } catch (e) {
    assert.fail(`http test failed: ${e.message}\nserver log:\n${getLog()}`);
  } finally {
    child.kill('SIGTERM');
  }
});

test('MCP HTTP: initialize + tools/list with valid API key', async () => {
  const { child, port, getLog } = spawnHttp({ MCP_MAX_BODY_BYTES: '65536' });
  try {
    await waitFor(async () => {
      try { return (await request(port, 'GET', '/health')).status === 200; } catch { return false; }
    }, 10000);

    const init = await request(port, 'POST', '/mcp', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-secret-key',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    assert.ok([200, 202].includes(init.status), `init status ${init.status} body=${init.body.slice(0, 300)}`);
    const sessionId = init.headers['mcp-session-id'];
    assert.ok(sessionId, 'expected mcp-session-id');

    await request(port, 'POST', '/mcp', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-secret-key',
        'Mcp-Session-Id': sessionId,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    const listed = await request(port, 'POST', '/mcp', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-secret-key',
        'Mcp-Session-Id': sessionId,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.ok([200, 202].includes(listed.status), `tools/list status ${listed.status}`);
    assert.ok(
      listed.body.includes('health.get') || listed.body.includes('"tools"'),
      `tools/list body unexpected: ${listed.body.slice(0, 500)}`
    );
  } catch (e) {
    assert.fail(`http init/list failed: ${e.message}\nserver log:\n${getLog()}`);
  } finally {
    child.kill('SIGTERM');
  }
});

test('MCP HTTP: session credential mismatch', async () => {
  const { child, port, getLog } = spawnHttp({ MCP_MAX_BODY_BYTES: '65536', MCP_API_KEY: 'key-one' });
  try {
    await waitFor(async () => {
      try { return (await request(port, 'GET', '/health')).status === 200; } catch { return false; }
    }, 10000);

    const init = await request(port, 'POST', '/mcp', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer key-one',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    const sessionId = init.headers['mcp-session-id'];
    assert.ok(sessionId);

    const mismatch = await request(port, 'POST', '/mcp', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-other-key',
        'Mcp-Session-Id': sessionId,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.ok([401, 403].includes(mismatch.status), `expected 401/403 got ${mismatch.status} body=${mismatch.body}`);
    if (mismatch.status === 403) {
      assert.ok(mismatch.body.includes('session_credential_mismatch'));
    }
  } catch (e) {
    assert.fail(`session mismatch failed: ${e.message}\n${getLog()}`);
  } finally {
    child.kill('SIGTERM');
  }
});
