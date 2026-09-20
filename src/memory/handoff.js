/**
 * Markdown handoff projections — NOT source of truth. Atomic write + version.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactDeep } from '../security/redaction.js';

async function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

export async function projectHandoff(stateDir, snapshot) {
  const safe = redactDeep(snapshot);
  const version = (safe.version || 1);
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

> Projection only. Source of truth: SQLite DB.
`;

  const projectState = `# PROJECT_STATE

- name: karlancer-telegram-agent
- architecture: API-first + MCP + durable worker
- playwright_in_production: false
- db: SQLite single-node
- updated_utc: ${now}
- version: ${version}

## Capabilities
${(safe.capabilities || []).map((c) => `- ${c}`).join('\n') || '- see docs/API_FIRST_AUDIT.md'}
`;

  await atomicWrite(path.join(stateDir, 'AGENT_HANDOFF.md'), handoff);
  await atomicWrite(path.join(stateDir, 'PROJECT_STATE.md'), projectState);

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

  const changelogPath = path.join(stateDir, 'CHANGELOG_AGENT.md');
  let clog = '';
  try {
    clog = await fs.readFile(changelogPath, 'utf8');
  } catch {
    clog = '# CHANGELOG_AGENT\n\n';
  }
  await atomicWrite(
    changelogPath,
    clog + `\n- ${now} — ${safe.lastChange || 'handoff update'} (v${version})\n`
  );

  return { version, updatedAt: now };
}

export async function bumpHandoffMeta(db, stateDir, snapshot) {
  const row = db.prepare(`SELECT version FROM handoff_meta WHERE key = 'main'`).get();
  const version = (row?.version || 0) + 1;
  const updatedAt = new Date().toISOString();
  const content = JSON.stringify(redactDeep({ ...snapshot, version }));
  db.prepare(
    `INSERT INTO handoff_meta (key, version, content, updated_at) VALUES ('main', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET version = excluded.version, content = excluded.content, updated_at = excluded.updated_at`
  ).run(version, content, updatedAt);
  await projectHandoff(stateDir, { ...snapshot, version });
  return version;
}
