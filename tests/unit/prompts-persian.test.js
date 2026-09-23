import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSIAN_WRITING_RULES,
  WRITE_PROPOSAL_SYSTEM,
  REPLY_SYSTEM,
  ANALYZE_SYSTEM,
  buildSystemPrompt,
} from '../../src/agent/prompts.js';
import { cleanHumanReply } from '../../src/agent/reply-clean.js';
import { createLlmProvider } from '../../src/llm/provider.js';

const BAN_SNIPPETS = [
  'می‌باشد',
  'لازم به ذکر است',
  'در راستای',
  'نقش بسزایی',
  'در دنیای امروز',
  'نیم‌فاصله',
  'هکسره',
];

test('PERSIAN_WRITING_RULES contains key bans and orthography', () => {
  for (const snip of BAN_SNIPPETS) {
    assert.match(PERSIAN_WRITING_RULES, new RegExp(snip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(PERSIAN_WRITING_RULES, /formal-but-human|رسمی ولی انسانی/);
  assert.match(PERSIAN_WRITING_RULES, /chat-natural|محاوره/);
  assert.ok(PERSIAN_WRITING_RULES.length < 4500, 'rules stay compact (not universal dump)');
});

test('stage prompts embed PERSIAN_WRITING_RULES and avoid em dash', () => {
  for (const block of [WRITE_PROPOSAL_SYSTEM, REPLY_SYSTEM, ANALYZE_SYSTEM]) {
    assert.match(block, /می‌باشد/);
    assert.match(block, /در دنیای امروز/);
    assert.doesNotMatch(block, /\u2014/);
    assert.doesNotMatch(block, /\u2013/);
  }
  assert.match(WRITE_PROPOSAL_SYSTEM, /formal-but-human/);
  assert.match(REPLY_SYSTEM, /chat-natural/);
  assert.match(PERSIAN_WRITING_RULES, /U\+2014|em\/?en/);
});

test('buildSystemPrompt stages include bans', () => {
  const write = buildSystemPrompt('write');
  const reply = buildSystemPrompt('reply');
  assert.match(write, /نقش بسزایی/);
  assert.match(reply, /لازم به ذکر است/);
  assert.match(buildSystemPrompt('reply', 'کوتاه‌تر'), /کوتاه‌تر/);
});

test('cleanHumanReply light orthography: ZWNJ, ye/kaf, dash, digits', () => {
  const arabicYe = 'علي'; // ي Arabic
  const withSpace = 'می شود و کتاب ها';
  const dashed = 'متن — توضیح';
  const arabDigits = 'قيمت ٤٥٦'; // Arabic kaf + Arabic-Indic digits
  const out = cleanHumanReply([arabicYe, withSpace, dashed, arabDigits, 'راهکار می‌باشد.'].join('\n'));
  assert.match(out, /علی|على/); // Persian ye preferred
  assert.match(out, /می‌شود/);
  assert.match(out, /کتاب‌ها/);
  assert.doesNotMatch(out, /\u2014|\u2013/);
  assert.doesNotMatch(out, /می‌باشد|می باشد/);
  assert.match(out, /است/);
  assert.match(out, /[۰-۹]{3}/); // Persian digits from Arabic-Indic
});

test('LLM provider system prompts include Persian bans when calling API', async () => {
  /** @type {string[]} */
  const systems = [];
  const llm = createLlmProvider({
    apiKey: 'test-key',
    enabled: true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body || '{}'));
      const sys = body.messages?.find((m) => m.role === 'system')?.content || '';
      systems.push(sys);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'x',
                    requirements: [],
                    assumptions: [],
                    missing_information: [],
                    complexity: 'low',
                    estimated_days: 3,
                    price_range: { min: 1, max: 2, currency: 'IRR' },
                    risks: [],
                    confidence: 0.5,
                    evidence: [],
                    proposal_text: 'سلام، پیشنهاد اولیه را آماده کردم برای بررسی شما.',
                    scope_included: [],
                    scope_excluded: [],
                    timeline: '۳ روز',
                    price: 1000,
                    questions: [],
                    reply_text: 'سلام، پیام را خواندم.',
                    tone: 'polite',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
      };
    },
  });

  await llm.analyzeProject({ title: 't', description: 'd'.repeat(80) });
  await llm.draftProposal({ project: { title: 't' }, analysis: { estimated_days: 3 } });
  await llm.draftChatReply({ employerMessage: 'سلام' });

  assert.equal(systems.length, 3);
  for (const sys of systems) {
    assert.match(sys, /می‌باشد/);
    assert.match(sys, /در دنیای امروز/);
    assert.match(sys, /نیم‌فاصله/);
  }
  assert.match(systems[1], /formal-but-human/);
  assert.match(systems[2], /chat-natural/);
});
