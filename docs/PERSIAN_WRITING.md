# Persian writing rules (Karlancer agent)

## Upstream skill (not MCP)

Full skill: [ali2000hos/persian-writing](https://github.com/ali2000hos/persian-writing)  
Local copy used for extraction: `/home/box/agent-data/workflows/persian-writing/` (SKILL.md + references/).

This is an agent **skill** (writing/register/orthography guidance). It is **not** an MCP server. Do not claim MCP was installed for Persian writing.

The upstream `universal/persian-writing-universal.md` is ~146KB. **Do not vendor that file into this repo.**

## What we inlined

Compact block: `PERSIAN_WRITING_RULES` in [`src/agent/prompts.js`](../src/agent/prompts.js).

Included in:

- `ANALYZE_SYSTEM` / `WRITE_PROPOSAL_SYSTEM` / `REPLY_SYSTEM`
- `buildSystemPrompt(stage)` used by [`src/llm/provider.js`](../src/llm/provider.js) for analyze / proposal / chat drafts

Register split:

| Artifact | Register |
|----------|----------|
| Proposal / analyze summaries | formal-but-human |
| Short client chat replies | chat-natural, still professional (شما; not slangy) |

Key bans inlined: می‌باشد، لازم به ذکر است، در راستای، نقش بسزایی، em dash, rule-of-three AI tells, «در دنیای امروز», plus orthography (نیم‌فاصله، ی/ک، ارقام فارسی، گیومه، no هکسره).

## Light post-process

[`src/agent/reply-clean.js`](../src/agent/reply-clean.js) applies a **cheap** mechanical pass (Arabic ي/ك → Persian, Arabic-Indic digits → Persian, em/en dash → ،, می/نمی + space → ZWNJ). Prompt rules remain the primary control.

## Smart bid

[`src/opportunity/smart-bid.js`](../src/opportunity/smart-bid.js) is deterministic (no LLM). Templates stay formal-but-human and go through `cleanHumanReply`.
