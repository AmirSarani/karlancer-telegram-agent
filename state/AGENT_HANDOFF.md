# AGENT_HANDOFF

- timestamp_local: 2026-09-20 23:07 IRST (Asia/Tehran)
- agent: interim-karlancer
- branch: `api-first-mcp-agent`
- status: **live auth OK on VPS**; first rooms page sampled; docs finalized
- PR: [#1](https://github.com/AmirSarani/karlancer-telegram-agent/pull/1) **OPEN — keep unmerged**
- repo: public `https://github.com/AmirSarani/karlancer-telegram-agent.git`

## Current facts

| Piece | Value |
|-------|-------|
| VPS | `77.221.156.164` `/opt/karlancer-telegram-agent` |
| Service | running; Telegram `@KarlanserAlertbot`; `main_boot` **auth:true** |
| UX SHA (pre-docs) | `0c3c952` Persian reply/inline keyboards |
| Live rooms | GET `/api/rooms/?page=1` → **200**; Laravel pagination; **total≈1016**, **per_page=10**, **last_page≈102** |
| Bid/chat POST | still `blocked_by_missing_api` until HAR → `VerifiedMutationContract` |
| Tenant | `default` is not a wildcard; cross-tenant needs `cross_tenant_admin` or `super_admin` |

## Deploy lesson (critical)

**Do not bash-source a JWT into remote `.env` via unquoted echo/source.** JWT characters break in shell. Prefer:

1. Write token to a local temp file (mode 600), **scp** to server, merge into `.env`, shred local.
2. Or pipe via stdin to `deploy/scripts/install-karlancer-token.sh` (reads one line; no argv).

Never commit tokens. Never paste into chat/logs.

## Last actions

1. Live rooms.list confirmed; shape notes in `EXPERIENCE.md` / `LIVE_SCAN.md`.
2. Successor docs + playbook + stdin install script.
3. Documented Telegram `/scan` → enqueues `rooms.scan` (owner-only).

## Blockers

1. Bid/chat mutations blocked until verified HAR contract.
2. Full invite triage across 102 pages not automated this session — owner can `/scan` or successor pages deeper.
3. Do not merge PR #1 without owner.

## Next actions

1. Owner: Telegram `/scan` (or reply-keyboard scan) while service running.
2. Successor: unread-first / deeper pages; Persian invite summary; HITL proposal plans only.
3. Capture redacted HAR for bid/chat; register contract.
4. Keep appending to `EXPERIENCE.md`.

## Safety

- No secrets in git. `state/LIVE_SCAN.json` is gitignored (may contain guest names).
- No unsolicited bid/chat POST.
- Mutations: retries=0; unknown → `needs_reconciliation`.
