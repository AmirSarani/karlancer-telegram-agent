import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { bumpHandoffMeta } from '../../src/memory/handoff.js';

test('concurrent handoff writers produce monotonic versions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klr-ho-'));
  const db = openDb(path.join(dir, 'h.sqlite'));
  const stateDir = path.join(dir, 'state');
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      bumpHandoffMeta(db, stateDir, {
        agent: `w${i}`,
        status: 'running',
        lastChange: `change-${i}`,
        nextAction: 'x',
        queueDepth: i,
        pendingApprovals: 0,
        blockers: [],
        inProgress: [],
        capabilities: ['test'],
      })
    )
  );
  const unique = new Set(results);
  assert.equal(unique.size, results.length, 'each writer must get distinct version');
  const final = db.prepare(`SELECT version FROM handoff_meta WHERE key = 'main'`).get();
  assert.equal(final.version, Math.max(...results));
  const handoff = fs.readFileSync(path.join(stateDir, 'AGENT_HANDOFF.md'), 'utf8');
  assert.match(handoff, /version:/);
  assert.doesNotMatch(handoff, /Bearer\s+[A-Za-z0-9]/);
});
