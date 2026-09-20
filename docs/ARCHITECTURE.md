# Architecture — Karlancer API-first MCP Agent

```text
MCP Clients (Cursor / ChatGPT / API-key)
        │  stdio | Streamable HTTP
        ▼
MCP Gateway (src/mcp)
  tools / resources / prompts / API-key scopes / audit
        │
        ▼
API adapters (src/api) ──HTTPS──► www.karlancer.com/api/*
        │
Durable Worker + SQLite queue (src/worker, src/memory)
        │
Telegram HITL (src/telegram) — approvals / pause / scan
        │
Markdown projections (state/) ← not source of truth
```

- **No Playwright** on the production path (`npm run guard:playwright`).
- Long work is job-based (`job_id`, leases, retry, `needs_reconciliation`).
- Mutations (`bids.submit`, `messages.send`) require approval; unverified endpoints return `blocked_by_missing_api` with attempt evidence.
- MCP pin: `@modelcontextprotocol/sdk` ^1.12 (Streamable HTTP + stdio).
