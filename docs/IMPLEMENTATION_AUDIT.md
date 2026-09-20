# IMPLEMENTATION_AUDIT — Karlancer API-First MCP Agent

**Date:** 2026-09-20 (Asia/Tehran)  
**Branch:** `api-first-mcp-agent`  
**Baseline commit:** `f7b5f14`  
**Companion evidence:** `AmirSarani/karlancer-extension` v1.6.9 (content.js, shared/room-messages.js, README)

Statuses: `implemented` | `tested` | `verified_live` | `blocked` | `not_applicable`

| قابلیت | endpoint واقعی | روش احراز هویت | evidence | وضعیت | تست live | blocker |
|---|---|---|---|---|---|---|
| rooms.list | `GET /api/rooms/?page=N` | Bearer `KARLANCER_ACCESS_TOKEN` | extension content.js scan | tested | not_verified (no token in CI) | need operator token for verified_live |
| room.messages | `GET /api/rooms/{id}/messages-pg?page=N` | Bearer | extension messages-pg | tested | not_verified | token |
| bids.check | `GET /api/check-bid?projectIds[0]=ID` | Bearer | extension | tested | not_verified | token |
| project resolve slug | `GET /api/publics/projects/{id}` | none (public) | extension + public HTTP 400 probe | tested | verified_live (route exists) | — |
| project detail | `GET /api/publics/projects/{slug}` | none (public) | extension | tested | partial | — |
| bids.submit | **none verified** | — | extension try-list only; README unverified | blocked | n/a | `blocked_by_missing_api` until HAR 2xx |
| messages.send | **none verified** | — | extension getSendApiCandidates | blocked | n/a | same |
| messages.mark_seen | **none verified** | — | extension try-list | blocked | n/a | same |
| user.me | try-list GET `/api/user` etc. | Bearer | extension | blocked / partial | n/a | no definitive path |
| login / refresh | none | env token only | no OAuth in extension | blocked | n/a | operator rotates env token |
| MCP stdio | local transport | process trust | InMemory + stdio entry | tested | n/a | — |
| MCP HTTP | `/mcp` Streamable HTTP | API key scopes + session bind | http-protocol tests | tested | n/a | — |
| Worker lease/heartbeat | SQLite jobs | — | integration tests | tested | n/a | — |
| LLM analyze/proposal/draft | OpenAI-compatible | `OPENAI_API_KEY` | provider + fallback tests | implemented / tested (deterministic without key) | not_verified | key optional |
| Intelligence L1–5 | local rules+memory | — | engine tests; insufficient_data honest | tested | n/a | ML training not in production |
| Playwright | — | — | removed; guard CI | not_applicable | n/a | forbidden in production |

## Non-negotiables checklist

- [x] No Playwright/Selenium/DOM in production path; `npm run guard:playwright`
- [x] No chat requests for tokens; secrets from env only; redaction in logs/MD/audit
- [x] Bid/chat: no tryPost try-lists; `VerifiedMutationContract` only; timeout → `needs_reconciliation`, never second POST
- [x] Honest statuses; no fake green live claims without token

## HAR capture (operator machine only)

See `docs/HAR_CAPTURE.md`. Never paste tokens into chat/issues/commits.
