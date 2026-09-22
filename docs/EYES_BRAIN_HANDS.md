# Eyes / Brain / Hands — folder map

Daily product path is **Telegram** (HITL). **MCP** is remote control for Cursor/API clients — not the owner’s day-to-day UI.

```text
Eyes (perceive)          Brain (decide)              Hands (act)
─────────────────        ────────────────            ──────────────────
src/api/adapters/*       src/opportunity/*           src/telegram/mutation-request.js
src/api/models/*         src/telegram/permission-gate.js
src/opportunity/scanner  src/telegram/agent-settings.js  src/api/contracts/verified-mutation.js
src/agent/messages-poll  src/opportunity/scoring.js  src/worker/handlers.js
src/opportunity/normalize  src/opportunity/rules-engine   src/worker/queue.js
                         src/opportunity/decision-engine
                         src/opportunity/feedback.js
                         src/intelligence/*
```

| Layer | Role | Notes |
|-------|------|-------|
| **Eyes** | HTTPS adapters to karlancer.com; normalize opportunities/rooms/messages | No Playwright. Soft-fail invites. |
| **Brain** | Rules + explainable score + feedback bias + PermissionGate + modes | Score ≠ permission. Auto never unlimited. |
| **Hands** | mutation-request → job queue → VerifiedMutationContract | Never bypass contracts. |

## Extension vs telegram-agent

- **karlancer-extension** (browser) = knowledge bed / HAR evidence / field discovery.
- **karlancer-telegram-agent** = production logic, persistence, Telegram UX, MCP gateway.

Do not re-implement business logic in the extension; feed evidence into adapters + contracts here.

## MCP vs Telegram

| Path | Audience | Use |
|------|----------|-----|
| Telegram | Owner (daily) | Dashboard, فرصت‌ها, صندوق تصمیم, approvals, settings, smart bid HITL |
| MCP stdio/HTTP | Cursor / automation | Remote tools, jobs, memory — same adapters + gate |

## Related docs

- `docs/ARCHITECTURE.md` — process topology
- `docs/RULE_ENGINE.md` — opportunity rules
- `docs/TELEGRAM_EXECUTION_MODES.md` — Manual / Assisted / Auto
- `docs/AUTOMATION_FLOW.md` — scan → decide → gate
- `scripts/rotate-secrets.md` — manual secret rotation

- `docs/PLAN2_LITE.md` — post-win scaffold (HITL)
- `docs/BALE_NOTIFY.md` — optional Bale fan-out
