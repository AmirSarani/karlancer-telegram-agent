# Plan 2 lite — پس از برد (scaffold)

Minimal post-win path. **Not** a full delivery agent.

## Goal

When a win signal appears (notification / message copy), scaffold:

```text
WON detected → first client message draft → owner HITL approve/send
```

No automatic delivery milestones, no unlimited messaging, no Playwright.

## Detection

`src/opportunity/post-win.js` → `detectWinSignal` / `scanNotificationsForWins`.

Patterns (Persian + English heuristics): انتخاب شد، برنده، پذیرفته شد، awarded, hired, …

False positives possible — owner always confirms before send.

## State machine (lite)

| Phase | Meaning |
|-------|---------|
| `DETECTED` | Win phrase matched |
| `DRAFT_READY` / `AWAITING_OWNER` | First client message draft ready |
| `SENT` | Owner approved send (future wire) |
| `CLOSED` | Done / dismissed |

Opportunity store may mark project state `WON` (added to `OPP_STATES`).

## Telegram

Settings → **🏆 پس از برد** shows scaffold + draft when a signal is found.

ارسال فقط با تأیید دستی (HITL). Same PermissionGate + VerifiedMutationContract as other messages.

## Out of scope (later Plan 2)

- Full delivery checklist / file handoff agent
- Automatic milestone invoices
- Multi-step project CRM

## Related

- `docs/EYES_BRAIN_HANDS.md`
- `docs/TELEGRAM_EXECUTION_MODES.md`
