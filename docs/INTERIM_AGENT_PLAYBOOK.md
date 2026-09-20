# Interim Agent Playbook

Until the automated Karlancer agent fully replaces the operator:

1. **Auth:** use `KARLANCER_ACCESS_TOKEN` (site `localStorage` `auth-token` → `access_token`) via secret store / server `.env` only — never chat.
2. **Deploy token:** **scp** a mode-600 file or **stdin** into `deploy/scripts/install-karlancer-token.sh` / Python-merge into `/opt/karlancer-telegram-agent/.env`. **Never** `source` or unquoted bash-expand a JWT (`$` corrupts it).
3. **Reads first:** `GET /api/rooms/?page=N`, then `GET /api/rooms/{id}/messages-pg?page=N` (`data.messages.data[]`).
4. **Projects:** prefer slug from message HTML `/projects/{slug}` → `GET /api/publics/projects/{urlencoded-slug}`. **Do not trust `active_plan_id` as project id.**
5. **Writes:** no bid/chat POST without `VerifiedMutationContract` + human approval.
6. **Memory for successors:** append `state/EXPERIENCE.md`, update `state/AGENT_HANDOFF.md` / `LIVE_SCAN.md`; keep PII scans out of public git (`LIVE_SCAN.json`, `ROOM_*`, `MSG_SHAPE_*` gitignored).
7. **Telegram:** `@KarlanserAlertbot` owner-only; UI buttons; `/scan` enqueues `rooms.scan` page 1; status should show Karlancer auth when token present.

## Known facts

| Item | Value |
|------|-------|
| Repo | public `AmirSarani/karlancer-telegram-agent` |
| Branch | `api-first-mcp-agent` (keep PR #1 **unmerged**) |
| UX tip | `0c3c952` Persian reply/inline keyboards |
| VPS | `77.221.156.164` `/opt/karlancer-telegram-agent` |
| Live rooms (2026-09-20) | ~1016 total, 10/page, ~102 pages; auth:true on VPS |

## Token install (JWT-safe)

```bash
set -a; source /workspace/secrets/karlancer-deploy.env; set +a
export SSHPASS="$DEPLOY_PASS"
printf '%s' "$KARLANCER_ACCESS_TOKEN" | sshpass -e ssh -o StrictHostKeyChecking=accept-new   "${DEPLOY_USER}@${DEPLOY_HOST}" 'bash -s' < deploy/scripts/install-karlancer-token.sh
```

Or scp a 600 tempfile and merge on the server. Restart discovered units (`karlancer-telegram-agent.service` and/or `mcp-agent` / `mcp-http`).

## Trigger rooms.scan

- **Telegram:** owner `/scan` (or reply-keyboard) on `@KarlanserAlertbot`.
- **MCP:** `project.list_invites`.
- **Scheduler:** every 5 minutes when worker enabled.
- Scan is read-path only regarding bids — still no POST without contract + approval.

## Operating loop

```
auth OK → rooms.list → messages-pg → resolve project via slug → check-bid →
LIVE_SCAN + EXPERIENCE → Persian summary → HITL proposal plans only → push docs
```

## Report shape for parent → user

1. Docs paths + commit SHA
2. auth:true / rooms.list status (never token)
3. Room/invite counts
4. Persian-ready owner actions
5. Blockers
