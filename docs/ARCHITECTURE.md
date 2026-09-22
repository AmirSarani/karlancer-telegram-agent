# Architecture — Karlancer API-first MCP Agent

See also **[EYES_BRAIN_HANDS.md](./EYES_BRAIN_HANDS.md)** (folder map; MCP = remote control; daily path = Telegram).


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
- MCP pin: `@modelcontextprotocol/sdk` **1.12.1** (exact; Streamable HTTP + stdio). Uses SDK `resource()` / `prompt()` / `registerTool()` APIs.
- **Topology:** one SQLite writer (`index` or `worker`) holds `acquireSingleNodeLock` with heartbeat; MCP HTTP/stdio attach as clients of that DB. Telegram HITL is optional (`ENABLE_TELEGRAM=false` for headless).
- **Multi-tenant:** API keys bind to `tenantId`; tools and `/jobs` are tenant-scoped.
