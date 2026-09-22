# Telegram execution modes (HITL / automation)

Default: **Manual**. Auto is never unlimited.

## Modes

| Mode | Behavior |
|------|----------|
| 🟢 Manual | Analyze / draft / suggest only. Every mutation needs Telegram approval → preview → owner → VerifiedMutationContract. |
| 🟡 Assisted | Prepares everything. Low-risk auto OK when toggle on (mark notification read). Send message / submit bid still need approval. |
| 🔴 Auto | Granular toggles + Automation Rules + daily limits. Without a matching rule, auto does not fire. |

## Safety

- Daily limits (default): max 5 auto messages / 10 auto bids
- Blacklist: rooms / users / keywords
- 🛑 Emergency stop: disables all auto toggles, forces Manual
- Audit: every gate decision in `audit_log` (`tool=permission_gate`)
- Mutations still go through existing VerifiedMutationContract — PermissionGate never bypasses contracts

## Commands

`/mode` · `/automation` · `/show_rules` · `/emergency_stop` · Settings menu equivalents

## Scoring

Match-score / confidence fields exist in rule schema but `scoringAvailable` defaults **false** — rules stay OFF until configured.

## Modules

- `src/telegram/agent-settings.js` — SQLite `kv` persistence
- `src/telegram/permission-gate.js` — mode / toggles / rules / limits / emergency
- `src/telegram/mutation-request.js` — enqueue + HITL / auto-approve with hash integrity
