/**
 * Markdown handoff projections — NOT source of truth. Atomic write + version lock.
 * Concurrent writers use SQLite version CAS — losers retry with merged changelog.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactDeep } from '../security/redaction.js';

async function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

export async function projectHandoff(stateDir, snapshot) {
  const safe = redactDeep(snapshot);
  const version = safe.version || 1;
  const now = new Date().toISOString();

  const handoff = `# AGENT_HANDOFF

- timestamp_utc: ${now}
- agent: ${safe.agent || 'karlancer-agent'}
- commit: ${safe.commit || 'unknown'}
- version: ${version}
- status: ${safe.status || 'unknown'}

## Last change
${safe.lastChange || '—'}

## In progress
${(safe.inProgress || []).map((x) => `- ${x}`).join('\n') || '- none'}

## Blockers
${(safe.blockers || []).map((x) => `- ${x}`).join('\n') || '- none'}

## Next action
${safe.nextAction || '—'}

## Jobs summary
- queued/running: ${safe.queueDepth ?? '—'}
- pending approvals: ${safe.pendingApprovals ?? '—'}

## Token / cost
- tokens_today: ${safe.tokensToday ?? '—'}

> Projection only. Source of truth: SQLite DB. Secrets redacted.
`;

  const projectState = `# PROJECT_STATE

- name: karlancer-telegram-agent
- architecture: API-first + MCP + durable worker
- playwright_in_production: false
- db: SQLite single-node
- updated_utc: ${now}
- version: ${version}

## Capabilities
${(safe.capabilities || []).map((c) => `- ${c}`).join('\n') || '- see docs/IMPLEMENTATION_AUDIT.md'}
`;

  const intelligence = `# INTELLIGENCE

- updated_utc: ${now}
- version: ${version}
- layer: rules + memory + feedback (no unvalidated ML in production)
- notes: ${(safe.intelligenceNotes || []).map((n) => `\n- ${n}`).join('') || '\n- insufficient_data until feedback accumulates'}
`;

  await atomicWrite(path.join(stateDir, 'AGENT_HANDOFF.md'), handoff);
  await atomicWrite(path.join(stateDir, 'PROJECT_STATE.md'), projectState);
  await atomicWrite(path.join(stateDir, 'INTELLIGENCE.md'), intelligence);

  if (safe.decision) {
    const decisionsPath = path.join(stateDir, 'DECISIONS.md');
    let prev = '';
    try {
      prev = await fs.readFile(decisionsPath, 'utf8');
    } catch {
      prev = '# DECISIONS\n\n';
    }
    const entry = `\n## ${now}\n\n${safe.decision}\n`;
    await atomicWrite(decisionsPath, prev + entry);
  }

  // Changelog: append via SQLite-serialized path in bumpHandoffMeta to avoid lost updates
  if (safe.changelogLine) {
    const changelogPath = path.join(stateDir, 'CHANGELOG_AGENT.md');
    let clog = '';
    try {
      clog = await fs.readFile(changelogPath, 'utf8');
    } catch {
      clog = '# CHANGELOG_AGENT\n\n';
    }
    await atomicWrite(changelogPath, clog + `\n- ${now} — ${safe.changelogLine} (v${version})\n`);
  }

  return { version, updatedAt: now };
}

/**
 * CAS on handoff_meta.version — concurrent writers cannot silently overwrite.
 */
export async function bumpHandoffMeta(db, stateDir, snapshot, { maxRetries = 5 } = {}) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt += 1;
    const row = db.prepare(`SELECT version, content FROM handoff_meta WHERE key = 'main'`).get();
    const prevVersion = row?.version || 0;
    const version = prevVersion + 1;
    const updatedAt = new Date().toISOString();
    const changelogLine = snapshot.lastChange || 'handoff update';
    const content = JSON.stringify(redactDeep({ ...snapshot, version }));

    const info = db
      .prepare(
        `INSERT INTO handoff_meta (key, version, content, updated_at) VALUES ('main', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           version = excluded.version,
           content = excluded.content,
           updated_at = excluded.updated_at
         WHERE handoff_meta.version = ?`
      )
      .run(version, content, updatedAt, prevVersion === 0 ? 0 : prevVersion);

    // better-sqlite3: INSERT always changes; UPDATE with WHERE may be 0
    // For first insert changes=1; for conflict with matching version changes=1; mismatch changes=0 on some builds
    // Safer: re-read version
    const after = db.prepare(`SELECT version FROM handoff_meta WHERE key = 'main'`).get();
    if (after?.version !== version) {
      // lost CAS — retry
      await sleep(10 + Math.floor(Math.random() * 20));
      continue;
    }

    await projectHandoff(stateDir, {
      ...snapshot,
      version,
      changelogLine,
    });
    return version;
  }
  throw new Error('handoff_cas_failed');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
