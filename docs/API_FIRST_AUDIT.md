# API-First Audit — karlancer-telegram-agent

**Date:** 2026-09-20 (Asia/Tehran)  
**Auditor:** api-first-mcp conversion agent  
**Sources of truth:** this repo (MVP), companion extension `AmirSarani/karlancer-extension` @ `61be5fc` (v1.6.9), brief `API_FIRST_MCP_BRIEF.md`  
**Live session probes:** not available (`KARLANCER_ACCESS_TOKEN` / cookies absent in env)

---

## Capability table (Phase 0)

| قابلیت | API موجود | API ناقص/غایب | روش فعلی | جایگزین API-first | ریسک | وضعیت |
|---|---|---|---|---|---|---|
| Auth / session | Bearer از `localStorage.auth-token` (`token_type` + `access_token`) در extension | لاگین برنامه‌ای/OAuth رسمی مستند نیست؛ refresh نامشخص | Playwright `storageState` stub | Env `KARLANCER_ACCESS_TOKEN` (+ optional Cookie) روی HTTP client | بدون token سرور کار نمی‌کند | **partial** — adapter auth header آماده؛ login API `blocked_by_missing_api` |
| List invite rooms | `GET /api/rooms/?page=N` (extension content.js) | schema کامل pagination/fields حدس‌زده از کد | Playwright stub / none | `rooms.list` adapter | متوسط | **available** (extension-confirmed) |
| Room messages | `GET /api/rooms/{id}/messages-pg?page=N` → `data.messages.data[]` | — | stub | `messages.list` | کم | **available** |
| Send room message | try-list: `POST /api/rooms/{id}/messages`, `/message`, `/api/messages`, `/api/rooms/messages` + payload shapes | **endpoint قطعی نیست** (README extension) | DOM fallback در extension | try-list adapter + HITL; بدون DOM | بالا | **partial / blocked_by_missing_api** تا تأیید Network |
| Mark room seen | try-list: `/api/rooms/{id}/seen\|read`, `/api/rooms/seen`, `/api/messages/seen` | قطعی نیست | DOM badge | try-list optional | متوسط | **partial** |
| Check bid submitted | `GET /api/check-bid?projectIds[0]=ID` → `data.has_submitted_bid` | — | none | `bids.check` | کم | **available** |
| Project by id → slug | `GET /api/publics/projects/{id}` → `data` = slug string | — | none | `projects.resolveSlug` | کم | **available** (public) |
| Project details | `GET /api/publics/projects/{slug}` → `data` project object | فیلدهای وضعیت برنده‌شدن heuristic | none | `projects.get` | کم | **available** (public) |
| Submit bid | try-list: `POST /api/bids`, `/api/projects/bid`, `/api/projects/{id}/bids` + payload variants | **unverified** — extension صریحاً می‌گوید endpoint تأیید نشده؛ fallback DOM | Playwright stub | try-list + **requires_approval**; بدون DOM | بالا | **partial / blocked_by_missing_api** |
| Current user id | try-list: `/api/user`, `/api/auth/user`, `/api/profile`, `/api/account` | کدام 200 می‌دهد نامشخص | none | `user.me` try-list | متوسط | **partial** |
| Stage/step APIs (pricing stages as HTTP) | — | هیچ endpoint «stage/step» در extension نیست؛ فقط prompt/policy متنی | prompts.js | Intelligence rules (local) نه HTTP | — | **not_applicable** (product concept ≠ site API) |
| Telegram control | grammY long poll | — | MVP commands stubs | Wire به jobs/approvals | کم | **available** (local) |
| LLM analyze/proposal | OpenAI-compatible (GapGPT/OpenAI) در extension SW | — | prompts.js unused at runtime | Optional via TokenBudgetManager | هزینه | **available** (external) |
| Persistence | JSON files per room | — | RoomMemory | SQLite + Markdown projections | کم | **to_implement** |
| MCP server | — | — | — | stdio + streamable HTTP | — | **to_implement** |
| Durable worker | — | — | — | SQLite queue + leases | — | **to_implement** |
| Playwright production path | — | — | `playwright` dep + `src/browser/karlancer.js` | Remove dep; quarantine module; CI guard | — | **remove** |

---

## 1. Current stack inventory

| Item | Value |
|------|--------|
| Language | Node.js ESM (`"type": "module"`), engines `>=18` |
| Framework | None (raw Node); Telegram via `grammy` |
| Entry | `src/index.js` → `npm start` / `npm run bot` |
| Process model | Single long-polling Telegram process |
| Persistence | `data/memory/{roomId}.json` |
| Browser | Playwright stubs only (`src/browser/karlancer.js`) — no real Karlancer automation wired |
| Tests | None in this repo |
| Secrets | `.env` (gitignored); `.env.example` has Telegram + OpenAI + storage state path |

## 2–4. Extension-discovered HTTP contracts

**Base URL:** `https://www.karlancer.com` (relative `/api/...` from page origin).

**Auth header (extension):**
```js
// localStorage key: auth-token
// JSON: {"token_type":"Bearer","access_token":"..."}
Authorization: Bearer <access_token>
Accept: application/json
// POST also: Content-Type: application/json, X-Requested-With: XMLHttpRequest
```

### Confirmed (used successfully in extension flows)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/rooms/?page={n}` | Invite scan pagination |
| GET | `/api/rooms/{roomId}/messages-pg?page={n}` | Nested `data.messages.data` |
| GET | `/api/check-bid?projectIds[0]={projectId}` | `data.has_submitted_bid` map |
| GET | `/api/publics/projects/{projectId}` | Returns slug in `data` |
| GET | `/api/publics/projects/{slug}` | Project object in `data` |

### Try-list / unverified (must not pretend confirmed)

| Method | Paths | Status |
|--------|-------|--------|
| POST | `/api/bids`, `/api/projects/bid`, `/api/projects/{id}/bids` | Bid submit — unverified |
| POST | room message endpoints (see table) | Chat send — unverified |
| POST | room seen/read variants | Unverified |
| GET | `/api/user`, `/api/auth/user`, `/api/profile`, `/api/account` | User id — try-list |

**Evidence:** `karlancer-extension` `content/content.js` (apiGet/apiPost, submitBidViaAPI, sendRoomMessageViaAPI), `shared/room-messages.js` (`getSendApiCandidates`), README note that chat-send endpoint is not definitive.

**Public probe (no auth):** `GET https://www.karlancer.com/api/publics/projects/1` → HTTP 400 (endpoint exists; bad id). Confirms publics route is live.

## 5. Playwright / browser automation

| Location | Role |
|----------|------|
| `package.json` dependency `playwright` | Production dep today |
| `src/browser/karlancer.js` | Launch, gotoMessages stub, screenshot, save storageState |
| README / .env | Documents headed manual login → storageState |

**Decision:** Remove Playwright from production dependency path; move browser helper out of runtime imports; add `scripts/guard-no-playwright.js` CI check. DOM fallbacks from extension are **not** ported.

## 6. External deps & limits

| Upstream | Purpose | Auth |
|----------|---------|------|
| karlancer.com `/api/*` | Core marketplace | Bearer token |
| api.openai.com / GapGPT | LLM | API key |
| api.telegram.org | Control channel | Bot token |

Rate limits: not documented in extension; adapters will use configurable timeout, retry on 5xx, and circuit-breaker hooks.

## 7. Business flows (API-first target)

1. **Scan invites:** `rooms.list` → filter keywords → `messages.list` → extract `project_id` → `bids.check` → `projects.get` → enqueue analyze job  
2. **Analyze / draft:** rules + optional LLM → approval record → Telegram HITL  
3. **Submit bid:** only after approval → bid try-list; on unknown outcome → `needs_reconciliation` + `bids.check`  
4. **Employer Q&A:** poll messages → draft reply → HITL → send try-list  
5. **MCP client:** tools enqueue jobs / read memory; never long-run inside tool handler  

## 8. Memory requirements

Jobs, approvals, events, room chat summaries, pricing decisions, audit log, token usage — SQLite source of truth; Markdown under `state/` as projections.

## 9. Missing / blocked APIs

1. **Official login/token refresh API** — blocked; operator must supply `KARLANCER_ACCESS_TOKEN` from browser session.  
2. **Definitive bid POST contract** — blocked_by_missing_api until Network capture with real 2xx.  
3. **Definitive chat send POST** — same.  
4. **Room seen POST** — optional UX; partial.  
5. **Site “stage/step” HTTP APIs** — do not exist; pricing stages are agent policy only.

How extraction was attempted:
- (a) Extension network wrappers + README — primary  
- (b) WebFetch publics endpoint — confirms route  
- (c) Authenticated probes — skipped (no session env)

## 10. Tests gap

No tests in telegram-agent. Extension has unit tests for history/pricing/room-messages. Need: unit, contract (fixture), MCP protocol, security, playwright-guard, e2e_api (mock + optional live).

---

## Migration map (Playwright → API)

| Old stub | New |
|----------|-----|
| `launch` + storageState | `KarlancerClient` with env token |
| `gotoMessages` | `messages.list` / MCP `room.messages` |
| screenshot HITL | Telegram text/approval cards (no browser) |
| future bid DOM | `bids.submit` try-list + approval |

## Next phases

1. Typed adapters + contract fixtures  
2. MCP stdio + HTTP  
3. Worker + SQLite queue  
4. Memory + handoff projections  
5. Token budget router  
6. Intelligence rules (minimal)  
7. Deploy + e2e reports  
