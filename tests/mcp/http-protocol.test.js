/**
 * MCP HTTP protocol: auth failure, health public, oversized body.
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
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('MCP HTTP: public health, auth failure on /mcp, body limit', async () => {
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
  };
  let stderr = '';
  const child = spawn(process.execPath, [path.join(root, 'src/mcp/http-entry.js')], {
    env,
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  child.stdout.on('data', (d) => {
    stderr += d.toString();
  });
  try {
    await waitFor(async () => {
      try {
        const r = await request(port, 'GET', '/health');
        return r.status === 200;
      } catch {
        return false;
      }
    }, 10000);
    const health = await request(port, 'GET', '/health');
    assert.equal(health.status, 200);
    const h = JSON.parse(health.body);
    assert.equal(h.status, 'ok');

    const unauth = await request(port, 'POST', '/mcp', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    assert.equal(unauth.status, 401);

    const big = 'x'.repeat(2000);
    const oversized = await request(port, 'POST', '/mcp', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-secret-key',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: big } }),
    });
    assert.equal(oversized.status, 413);
  } catch (e) {
    assert.fail(`http test failed: ${e.message}\nserver log:\n${stderr}`);
  } finally {
    child.kill('SIGTERM');
  }
});

async function waitFor(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for server');
}
