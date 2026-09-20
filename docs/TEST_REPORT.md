# TEST_REPORT — karlancer-telegram-agent API-first

**Date:** 2026-09-20 (Asia/Tehran)  
**Command:** `npm run test:all` (unit/contract/integration/mcp/security + e2e + playwright guard)

## Summary

| Suite | Pass | Fail | Skip |
|-------|------|------|------|
| unit + contract + integration + mcp + security | **29** | **0** | 0 |
| e2e_api | **3** | **0** | **1** (live auth — no token) |
| guard:playwright | **OK** | — | — |
| **Total executed assertions suites** | **32 pass** | **0 fail** | **1 skip** |

## Details

### Unit
- pricing rules, router, TokenBudgetManager
- job queue: idempotency, lease reclaim, approval gate
- redaction, SSRF host allowlist, API-key scopes

### Contract
- rooms / messages / bids.check / projects fixtures
- send try-list returns `blocked_by_missing_api` on all 404
- missing auth on protected routes

### Integration
- `health.ping`, `rooms.scan` (mock), `bids.submit` → `needs_reconciliation`

### MCP
- tool registry includes health, project, jobs, bids.submit_plan, memory, pricing, approvals

### Security
- playwright guard script exit 0
- injection/redaction + SSRF

### E2E API
- mock vertical slice: scan → approval bid → honest block → handoff projection
- lease recovery
- live `publics` probe (no auth) pass
- live `rooms.list` **SKIPPED** — `KARLANCER_ACCESS_TOKEN` unset (honest)

## Not faked
- Bid/send mutations are not marked green against live Karlancer; they assert `blocked_by_missing_api` / `needs_reconciliation` when try-list fails.
