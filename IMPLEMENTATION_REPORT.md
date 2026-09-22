# IMPLEMENTATION_REPORT

**Branch:** `api-first-mcp-agent`  
**Date:** 2026-09-20 (Asia/Tehran)

## Capability matrix

| قابلیت | پیاده‌سازی | تست محلی | تست live | evidence | blocker | next step |
|---|---|---|---|---|---|---|
| Read APIs (rooms/messages/check-bid/publics) | implemented | pass | not_verified / publics partial | extension + fixtures | token for live | operator runs `KARLANCER_ACCESS_TOKEN=… npm run test:e2e` |
| Bid submit | blocked | pass (no POST) | n/a | VerifiedMutationContract empty | missing HAR 2xx | docs/HAR_CAPTURE.md |
| Chat send | blocked | pass (no POST) | n/a | same | same | same |
| MCP stdio+HTTP | implemented | pass | n/a | protocol tests | — | connect Cursor via example configs |
| Worker heartbeat/retry/idempotency | implemented | pass | n/a | integration | — | — |
| wait=true claim bug | fixed | pass | n/a | claimById | — | — |
| Memory/handoff CAS | implemented | pass | n/a | concurrent test | — | — |
| LLM analyze/proposal/draft | implemented | pass (fallback) | not_verified | provider.js | optional OPENAI_API_KEY | set key for live LLM |
| TokenBudgetManager wired | implemented | pass (stale cache) | n/a | token_usage tables | — | — |
| Intelligence L1–5 | implemented | pass | n/a | insufficient_data honest | no ML in prod | collect feedback |
| Security suite | implemented | pass | n/a | §11 tests | — | — |
| Docker/CI | implemented | docker build in CI | n/a | `.github/workflows/ci.yml` | — | push triggers Actions |
| ENABLE_TELEGRAM=false | implemented | pass | n/a | config/index | — | — |

## Acceptance (§14) honesty

- Main path without Playwright: **yes**  
- Bid/Chat: **explicitly blocked** (feature off until contract) — not fake-complete  
- MCP stdio+HTTP tested: **yes**  
- Secrets not in repo: **yes** (examples empty)

## Local run / deploy / Cursor

See `docs/OPERATIONS.md`, `docs/MCP_PRODUCTION.md`, `configs/cursor-mcp.json.example`.

## Remaining limitations

1. Bid/chat POST require operator HAR → register contract.  
2. Live Karlancer auth tests skipped without env token.  
3. SQLite single-node only.  
4. ChatGPT/Codex remote not claimed connected — protocol ready only.

## Fix pass (P0/P1) — post b64ae69

- MCP SDK 1.12.1: adapted to `resource()` / `prompt()` (register* were wrong for this pin).
- Approval decide: hash from **job** payload; exact payload_json identity; atomic txn; `payload_tampered`.
- Single-node lock heartbeat wired in index + worker; test proves live lock not stealable.
- Multi-tenant: API key → tenantId; tools + `/jobs` scoped.
- Clean verify: npm test 75/0, test:e2e 3/0/1 skip, guard:playwright OK, docker build OK.

## Final hardening (PR #1)

- Tenant `default` is not a wildcard; cross-tenant requires `cross_tenant_admin` | `super_admin`.
- Intelligence/pricing/feedback memory is tenant-scoped (`getInsight(tenantId)`, `recordFeedback` → `memoryAppend(tenantId)`).
- Expired mutation leases (`bids.submit` / `messages.send` / `messages.mark_seen`) → `needs_reconciliation` (no second POST).
- Pre-mutation revalidation of approval/expiry/tenant/action/targetRef/payload before POST.
- VerifiedMutationContract loader fail-closed (no `z.any` fallback for unknown schemas).
- MCP sessions: TTL, cleanup interval, max count, shutdown cleanup.
- Lock renamed/aliased to single-worker-consumer; Karlancer credential default shared + optional encrypted per-tenant path.
- CI: `test:e2e:mock` required; `test:live` honest-skip without token.
