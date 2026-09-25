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


## Limited AUTO_EXECUTE (bids)

When mode=auto **and** opportunity rule action=`AUTO_EXECUTE` **and** `autoSubmitBids` **and** under daily bid limit **and** not emergency:

1. PermissionGate may return `auto_allow` after rule match.
2. Scanner still sets `forceRequireApproval` for the first `approvalPreviewFirstN` (default 3) auto actions of the day.
3. After preview budget, auto-approve goes through mutation-request as `auto:permission_gate:…` — **still** VerifiedMutationContract in the worker (blocked_by_missing_api until HAR registered).
4. Owner scoring profile must be configured (`scoringAvailable=true`) for score-threshold rules.

Never: unlimited auto, auto without matching rule, bypass of VerifiedMutationContract.

## Message auto rule: default criterion (Phase B)

- Enabled message rule with no criteria → auto only when AI confidence ≥ 60% (`DEFAULT_MESSAGE_SCORE_THRESHOLD`).
- Configure in Telegram: «📜 قوانین» → «✏️ معیار پیام خودکار» / «💸 سقف تخفیف و کف قیمت».
- Daily limit counts only automatic sends (Tehran day); owner-confirmed sends are audited as `owner.*`.
- Live sending still needs `ALLOW_LIVE_AUTO_SEND=true` (kept **false** on the production VPS) + gate + VerifiedMutationContract.
