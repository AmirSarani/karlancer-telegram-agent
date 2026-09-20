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

---

## 2026-09-20 — messages-pg + project resolve (live sample)

### messages-pg envelope

- `data` keys include: `room`, `room_unread`, `messages`, `has_reply`, `has_worksample`, `is_required_fulltime`, workdiary fields, `error_message`.
- `data.messages` is a **Laravel paginator object** (not a bare array): `current_page`, `total`, `last_page`, `per_page`, `data[]`, URL fields.
- Adapter already prefers `data.messages.data[]` via `extractMessageList`.

### room object (nested in messages response)

Extra fields beyond list view: `user_id`, `rate` / `rate_num` / `rate_sum`, `avatar`, `is_locked` / `am_locked`, `is_online`, `is_hidden`, quiz fields, `opening_trigger`. **`active_plan_id` is a plan id, not a Karlancer project id.**

### Project fetch

- Prefer project **slug** parsed from message HTML (`/projects/{slug}`) → `GET /api/publics/projects/{urlencoded-slug}`.
- Public project object includes: `id`, `title`, `description`, budgets, flags (`is_urgent`, `is_fulltime`, `is_expired`, …), `status`, `url`, etc.

### Follow-ups

- Map `guest_name` → adapter `title` if UX needs it.
- Owner `/scan` for continuous page-1 invite triage; deeper pagination still manual/successor work.

---

## 2026-09-20 — Telegram sync after rooms.scan

### Problem

- VPS lagged origin (`0c3c952` vs `aa12224`+); interim/API work never pushed owner-visible Telegram messages.
- `rooms.scan` emitted `rooms.scanned` but **did not notify** the owner chat — bot looked “not synced” with agent work.
- Status/welcome did not clearly show live Karlancer auth (`متصل`/`قطع`) or last scan time.

### Fix

- `src/telegram/notify.js`: `notifyOwner({ token, chatId, text, reply_markup? })` via grammY `api.sendMessage`; text redacted.
- `rooms.scan` builds a page summary (total/page, unreadOnPage, top 3–5 priority rooms with guest_name / id / unread / preview), stores `kv.last_scan_summary`, emits once.
- `src/index.js` `onEvent` → one Persian summary card per scan job (owner-only; dedupe by `scannedAt`).
- `/start` + status card: `کارلنسر: متصل|قطع` + آخرین اسکن from kv.
- Adapter maps `guest_name` → `guestName`/`title`; `last_message_preview` accepted.
- Unit tests: `tests/unit/telegram-notify.test.js` (formatter only, no live Telegram).

### Lesson

**Events ≠ owner UX.** Worker/handoff projections are not enough — every owner-visible job completion that matters for triage must call `notifyOwner` once with a redacted Persian card. Keep deploy SHA current or Telegram UX and API work diverge silently.

### Follow-up (same day): rooms.scan HTTP 400

- Root: `api.projects.get(projectId)` returns **HTTP 400** for many invite project ids (list/messages/bids OK).
- Effect: uncaught throw aborted entire `rooms.scan` before `rooms.scanned` → no Telegram card.
- Fix: per-room try/catch; soft-fail `projects.get` and still emit summary + notify.
