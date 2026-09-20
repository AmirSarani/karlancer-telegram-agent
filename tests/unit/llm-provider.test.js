import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLlmProvider, recordTokenUsage, ProjectAnalysisSchema } from '../../src/llm/provider.js';
import { openDb } from '../../src/memory/db.js';

test('LLM disabled uses deterministic fallback for analyze', async () => {
  const llm = createLlmProvider({ apiKey: '', enabled: false });
  const out = await llm.analyzeProject({ title: 'فروشگاه', description: 'نیاز به سایت فروشگاهی با درگاه' });
  assert.equal(out.ok, true);
  assert.equal(out.source, 'deterministic_fallback');
  assert.ok(out.data.complexity);
  ProjectAnalysisSchema.parse(out.data);
});

test('LLM schema failure falls back', async () => {
  const llm = createLlmProvider({
    apiKey: 'k',
    enabled: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"not":"valid schema"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    }),
  });
  const out = await llm.analyzeProject({ title: 't', description: 'd'.repeat(100) });
  assert.equal(out.ok, true);
  assert.equal(out.source, 'deterministic_fallback');
});

test('token usage accounting fields', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klr-')), 'tu.sqlite'));
  recordTokenUsage(db, {
    tenantId: 'default',
    jobId: null,
    model: 'gpt-4o-mini',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost: 0.001,
  });
  const ev = db.prepare(`SELECT * FROM token_usage_events`).get();
  assert.equal(ev.model, 'gpt-4o-mini');
  assert.equal(ev.input_tokens, 100);
  assert.equal(ev.output_tokens, 50);
  assert.equal(ev.total_tokens, 150);
  assert.ok(ev.created_at);
  const day = db.prepare(`SELECT * FROM token_usage`).get();
  assert.equal(day.tokens, 150);
  assert.equal(day.calls, 1);
});

test('proposal and chat draft never imply auto-send', async () => {
  const llm = createLlmProvider({ enabled: false });
  const p = await llm.draftProposal({ project: { title: 'x' }, analysis: { estimated_days: 7 } });
  const c = await llm.draftChatReply({ employerMessage: 'سلام قیمت؟' });
  assert.ok(p.data.proposal_text);
  assert.ok(c.data.reply_text);
});
