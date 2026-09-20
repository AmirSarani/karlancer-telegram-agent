# Interim agent playbook

Until the automated Karlancer agent fully replaces the operator:

1. **Auth:** use `KARLANCER_ACCESS_TOKEN` (site `auth-token`) via secret store / server `.env` only — never chat.
2. **Deploy token:** scp or Python-merge into `/opt/karlancer-telegram-agent/.env`; never `source` unquoted tokens in bash.
3. **Reads first:** `GET /api/rooms/?page=N`, then `GET /api/rooms/{id}/messages-pg?page=N` (`data.messages.data[]`).
4. **Projects:** prefer slug from message HTML `/projects/{slug}` → `GET /api/publics/projects/{urlencoded-slug}`. Do not trust `active_plan_id` as project id.
5. **Writes:** no bid/chat POST without VerifiedMutationContract + human approval.
6. **Memory for successors:** append `state/EXPERIENCE.md`, update `state/AGENT_HANDOFF.md`; keep PII scans out of public git (`state/LIVE_*`, `ROOM_*` gitignored).
7. **Telegram:** @KarlanserAlertbot owner-only; use UI buttons; status should show Karlancer auth when token present.
