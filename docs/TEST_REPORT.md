# TEST_REPORT

**Date:** 2026-09-20 (Asia/Tehran)  
**HEAD base:** `b64ae69` → this fix commit on `api-first-mcp-agent`  
**Node:** 20 · clean `rm -rf node_modules && npm ci`

## Commands

```bash
rm -rf node_modules && npm ci
npm test
npm run test:e2e
npm run guard:playwright
docker build -f deploy/Dockerfile .
```

## Results (actual clean run)

| Suite | Pass | Fail | Skip | Notes |
|-------|------|------|------|-------|
| `npm test` (unit/contract/mcp/security/integration) | **75** | **0** | 0 | Was 60/2 before P0 MCP SDK fix |
| `npm run test:e2e` | **3** | **0** | **1** | Live auth rooms skipped — no `KARLANCER_ACCESS_TOKEN` |
| `npm run guard:playwright` | OK | — | — | 35 files scanned |
| `docker build -f deploy/Dockerfile .` | OK | — | — | Image built successfully |

## Pre-fix reproduction (mandatory)

Clean Node 20 + `npm ci` + `npm test` on `b64ae69` = **60 pass / 2 fail**:

1. `MCP in-memory: initialize, tools/list, tools/call health.get` — `server.registerResource is not a function`
2. `MCP server registers required tools` — same

Claimed “62 pass / 0 fail” was incorrect; GitHub Actions `unit-contract-integration` and `mcp-stdio` also failed.

## Notable mandatory tests (now green)

- MCP stdio/in-memory: initialize, tools/list, **resources/list**, **resources/read**, **prompts/list**, tools/call, scope deny  
- MCP HTTP: public health, auth 401, body 413, **initialize + tools/list with valid key**, **session credential mismatch**  
- Approval integrity: tamper `jobs.payload_json`, tamper `approvals.payload_json`, metadata change, concurrent approve, crash/rollback atomicity  
- Single-node lock: live heartbeating holder cannot be stolen after stale window  
- Tenant isolation: API key → tenantId; cross-tenant `job.get_status` forbidden; list filter  
- Bid/message mutation timeout → no second POST  
- Stale token cache → not `use_cache`  
- claimById wait=true does not steal other jobs  
- Anon never admin  

## Topology (documented)

| Process | Role | SQLite lock |
|---------|------|-------------|
| `npm start` / `src/index.js` | Telegram HITL + optional embedded worker | Acquires `sqlite_primary` + heartbeat |
| `npm run worker` | Durable job consumer | Same lock (single writer) |
| `npm run mcp` (stdio) | MCP stdio gateway | Shares DB; prefer co-located or read-mostly |
| `npm run mcp:http` | MCP Streamable HTTP + `/jobs` | Auth + tenant-scoped; do not run a second writer |

Single-node SQLite: only one writer process should hold `acquireSingleNodeLock` with periodic heartbeat (< stale timeout, default 2 min).

## Multi-tenant model

Each API key is bound to a `tenantId` (`MCP_API_KEY_TENANT` or `MCP_API_KEYS=hash:scopes:tenantId`).  
Jobs, approvals, memory, intelligence, audit, and `/jobs` are scoped; cross-tenant → 403 / forbidden.

## Not run / blocked_external_dependency

- Live authenticated rooms/messages/check-bid (needs operator token)  
- Live bid/chat POST (`blocked_by_missing_api` — no VerifiedMutationContract)  
- Live OpenAI (optional; deterministic fallback covered)

## Honesty

Do **not** claim merge-ready bid/chat or “MCP fully production-verified against live Karlancer” without live evidence.  
CI green on this branch is the bar for MCP SDK + approval integrity + lock + tenant isolation.
