# AGENT_HANDOFF (complete — 2026-09-22 IRST)

- **timestamp:** 2026-09-22 ~06:55 Asia/Tehran
- **operator:** Su Karlancer (interim) → any successor
- **repo (public):** https://github.com/AmirSarani/karlancer-telegram-agent
- **branch / HEAD:** `api-first-mcp-agent` @ `0a1dd9e`
- **PR #1:** OPEN, MERGEABLE, CI green — **do not merge without owner**
  https://github.com/AmirSarani/karlancer-telegram-agent/pull/1
- **main:** still scaffold `6476fb3` (behind feature branch)

## Live production

| Piece | Value |
|-------|--------|
| VPS | `77.221.156.164` path `/opt/karlancer-telegram-agent` |
| systemd | `karlancer-telegram-agent.service` **active** @ `0a1dd9e` |
| Telegram | `@KarlanserAlertbot` owner chat `1366010187` |
| Karlancer auth | `.env` has `KARLANCER_ACCESS_TOKEN`; boot `auth:true` |
| Worker | embedded; jobs `messages.poll`, `health.ping`, `rooms.scan` running |
| DB | `/opt/karlancer-telegram-agent/data/agent.sqlite` |

## Architecture (one process)

`npm start` → Telegram long-poll + SQLite job queue + worker + optional MCP.
- Reads: typed HTTP adapters to karlancer.com (from extension contracts).
- Writes (bid/chat): **only** `VerifiedMutationContract` — currently **blocked_by_missing_api**.
- AI/LLM: analysis, notes, proposal draft polish — **not** the send path.
- Playwright: removed from production; CI guard.

## MCP

Transports: `npm run mcp` (stdio) · `npm run mcp:http` (Streamable HTTP, default `127.0.0.1:8787`).
Auth: `MCP_API_KEY`; anon never admin; tools tenant-scoped (`default` is ordinary tenant).
Key tools: `health.get`, `rooms.list`, `room.messages`, `project.get`, `project.list_invites`, `bids.check`, `bids.submit_plan`, `messages.send_plan`, `job.*`, `approvals.*`, `memory.*`, `pricing.*`, `intelligence.*`, `audit.search`.
Resources: `karlancer://handoff`, `karlancer://project-state`, `karlancer://api-audit`, `karlancer://api-catalog`.
Docs: `docs/MCP_TOOLS.md`, `docs/CONNECTING.md`, `configs/cursor-mcp.json.example`.

## Telegram UX (owner-only)

Reply menu: وضعیت · تأییدها · اسکن · مکث/ادامه · راهنما · **چت‌ها** · **خوانده‌نشده**
Room card: ✅ تأیید ارسال · ❌ رد · 📝 نوت · 🔄 تازه‌سازی · 🤖 تحلیل AI
Commands: `/start` `/help` `/status` `/scan` `/chats` `/unread` `/approvals` `/approve` `/reject` `/pause` `/resume` `/cancel`
After `rooms.scan` / `messages.poll`: Persian summary / room cards pushed to owner.

## Known live Karlancer API shapes

- `GET /api/rooms/?page=N` → Laravel pagination; ~1016 rooms, 10/page (~102 pages) when last sampled.
- `GET /api/rooms/{id}/messages-pg?page=N` → `data.messages.data[]` (paginated object).
- Projects: resolve via slug in message HTML → `GET /api/publics/projects/{urlencoded-slug}`; do **not** trust `active_plan_id` as project id.
- Sample unread focus (2026-09-20): room `7241431` / Ardeshir.A / project email extraction (fulltime; contact unlocked; prior bid 3M/3d).

## Blockers

1. **messages.send / bids.submit** need HAR → `docs/HAR_CAPTURE.md` → `configs/verified-mutations.local.json` (gitignored).
2. Login/refresh API absent — rotate `KARLANCER_ACCESS_TOKEN` manually when 401.
3. Credential shared-by-default on process; per-tenant encrypted path optional not default.
4. Root password + Telegram bot token were pasted in chat historically — **rotate if not already**.
5. SQLite single-worker-consumer — no multi-writer scale-out.

## Safety rules for successor

- Never paste secrets in chat; use secret-request / scp / stdin install script.
- Never bash-source unquoted JWT into `.env`.
- No tryPost / guessed endpoints; no Playwright production.
- Approve in Telegram without contract → draft/HITL only, honest block on real send.
- Do not commit `state/LIVE_*.json`, `ROOM_*`, tokens, HAR raw with cookies.

## Next actions

1. Owner verifies Telegram چت‌ها / خوانده‌نشده cards day-to-day.
2. Capture redacted HAR for chat send (+ bid if needed); register VerifiedMutationContract; redeploy.
3. Optional: merge PR #1 only after owner approval.
4. Append every live finding to `state/EXPERIENCE.md`.

## Doc index

`docs/INTERIM_AGENT_PLAYBOOK.md`, `state/EXPERIENCE.md`, `docs/HAR_CAPTURE.md`, `docs/API_FIRST_AUDIT.md`, `docs/TEST_REPORT.md`, `IMPLEMENTATION_REPORT.md`, `docs/OPERATIONS.md`
