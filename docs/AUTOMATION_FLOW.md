# Automation Flow — Opportunities

```
Karlancer API (projects.search / rooms+messages invites)
        ↓
   Intelligent Scanner (dedupe, since-last-scan)
        ↓
   Normalize → ProjectOpportunity
        ↓
   Rule Engine (SQLite conditions)
        ↓
   Scoring (0–100 + reasons)
        ↓
   Decision Engine (mode + rules + limits + emergency)
        ↓
   ┌─ IGNORE
   ├─ NOTIFY          → Telegram opportunity card
   ├─ CREATE_DRAFT    → state ACTION_CREATED (no live bid)
   ├─ REQUEST_APPROVAL→ mutation-request(bids.submit) + PermissionGate
   └─ AUTO_EXECUTE    → same path with forceRequireApproval (mock; no silent live spam)
```

## Modes (reuses existing PermissionGate)

| Mode | Opportunity behavior |
|------|----------------------|
| Manual | High score / rule → CREATE_DRAFT or NOTIFY — never silent mutation |
| Assisted | Draft/notify; bids still need approval |
| Auto | AUTO_EXECUTE only if rule matched + `autoSubmitBids` + daily limit + gate — **still forceRequireApproval in this build** |

## Safety (reused)

- `agent-settings`: mode, toggles, limits (`maxAutoBidsPerDay`), emergency stop
- `permission-gate`: blacklist, scoringAvailable, preview N
- `mutation-request` → VerifiedMutationContract (unchanged)
- Duplicate protection: `hasSubmittedOrAction` / state SUBMITTED|ACTION_CREATED
- Cooldown after scan (1 minute) + durable scheduler interval 30m
- Scheduler pauses when agent paused / respects emergency downgrade

## Schedule & manual

- Background: scheduler job `opportunities.scan` every **30 minutes**
- Manual: Telegram Settings → فرصت‌ها → اسکن فرصت‌ها · `/opportunities`

## Audit

Every decision is written to `opportunity_decisions` and mirrored to `audit_log` (`tool=opportunity_decision`) with `projectId`, `score`, `matchedRules`, `decision`, `mode`, timestamp.
