# EXPERIENCE (append-only)

Operational learnings. **No secrets.** Append dated sections; do not erase history.

---

## 2026-09-20 — Interim + first live rooms.list

### Auth / secrets

- Box Cloud Agent may inject only a subset of secrets (`CLOUD_AGENT_INJECTED_SECRET_NAMES`). Early this session only GitHub PAT was present; later VPS received Karlancer token and `main_boot` reported **auth:true**.
- **JWT deploy pitfall:** unquoted bash `source` / `echo TOKEN=...` **corrupts JWTs** (shell metacharacters such as `$`). **scp a mode-600 file** or **stdin pipe** into `install-karlancer-token.sh`. Never put token on argv or in git.
- Deploy SSH: `source /workspace/secrets/karlancer-deploy.env` for `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_PASS` only — never echo the file.

### Live API — GET `/api/rooms/?page=1`

- HTTP **200**, auth Bearer required.
- Laravel-style pagination observed:
  - `total` ≈ **1016**
  - `per_page` = **10**
  - `last_page` ≈ **102**
  - page 1 returns 10 rooms
- Useful room fields (live payload):

| Field | Meaning (observed) |
|-------|--------------------|
| `id` | numeric room id |
| `guest_name` | counterparty display / code name |
| `unread` | unread count; page1 had **1** room with unread flag |
| `is_open` | room open flag (0/1) |
| `employer_is_open` | employer-side open (often 1) |
| `is_archived` | archived flag |
| `active_plan_id` | plan id (e.g. 10) |
| `updated_at` | ISO timestamp |
| last message | Persian preview; invite-ish lines often include proposal or invitation phrasing |

- Adapter (`src/api/adapters/rooms.js`) normalizes to `{ id, lastMessage, unread, updatedAt, title, raw }`. Live title-like field is often `guest_name` — successor may map it explicitly in the adapter.
- Counts: `state/LIVE_SCAN.md`. Local raw JSON `state/LIVE_SCAN.json` is **gitignored** (public repo).

### Other confirmed reads (code + prior audit)

- `GET /api/rooms/{id}/messages-pg?page=N` — prefer `data.messages.data[]`
- `GET /api/check-bid?projectIds[i]=` — `data.has_submitted_bid`
- `GET /api/publics/projects/{id|slug}` — public
- Bid/chat POST: blocked until `VerifiedMutationContract`

### Telegram / worker

- Bot: `@KarlanserAlertbot`. Owner `/scan` → `queue.create({ goal: "rooms.scan", payload: { page: 1 } })`.
- Scheduler also runs `rooms.scan` every 5 minutes when worker enabled.
- HITL approve/reject via Telegram; no silent bid submit.

### Deploy / VPS

- Path `/opt/karlancer-telegram-agent`.
- Unit names vary: `karlancer-telegram-agent.service` and/or `mcp-agent.service` / `mcp-http.service` — discover before restart.
- PR #1 stays unmerged; deploy from branch as needed.

### Process lessons

- If token missing on box: finish docs + install script; do not hang.
- Summaries for owner in Persian; proposals = HITL plans only.

---

## Template

```
## YYYY-MM-DD — <context>
### What we tried / worked / failed (codes only)
### API / UX / deploy notes
### Follow-ups
```
