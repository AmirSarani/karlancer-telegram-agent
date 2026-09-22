# Rule Engine (Opportunity)

Data-driven rules for project/invite opportunities. **No hardcoded business policy** — conditions and actions live in SQLite (`opportunity_rules`).

## Model

```json
{
  "name": "wordpress-mid-budget",
  "enabled": true,
  "priority": 10,
  "action": "CREATE_BID_DRAFT",
  "conditions": [
    { "field": "skills", "op": "has_any", "value": ["وردپرس", "wordpress"] },
    { "field": "budgetMin", "op": "gte", "value": 5000000 },
    { "field": "ageHours", "op": "lte", "value": 48 }
  ]
}
```

### Fields

`title` · `description` · `skills` · `category` · `budgetMin` · `budgetMax` · `budget` · `ageHours` · `status` · `source` · `client.rate` · `isUrgent` · `isExpired`

### Operators

`contains` · `not_contains` · `eq` · `neq` · `gt` · `gte` · `lt` · `lte` · `between` · `in` · `has_any` · `has_all` · `exists`

### Actions

| Action | Meaning |
|--------|---------|
| `NOTIFY` | Telegram card only |
| `CREATE_BID_DRAFT` | Mark draft / prepare text — no live POST |
| `REQUEST_APPROVAL` | Enqueue `bids.submit` via PermissionGate + mutation-request (HITL) |
| `AUTO_EXECUTE` | Would auto — still routed through gate; **this build always `forceRequireApproval`** |
| `IGNORE` | Drop |

Empty `conditions` never match (forces explicit config).

## CRUD

```js
import { createOpportunityStore } from '../src/opportunity/store.js';
const store = createOpportunityStore(db);
store.createRule({ name, action, conditions, priority, enabled });
store.setRuleEnabled(ruleId, false);
store.updateRule(ruleId, patch);
store.deleteRule(ruleId);
store.listRules({ enabledOnly: true });
```

Telegram: Settings → فرصت‌ها → قوانین فرصت (enable/toggle + sample rule).

## Evaluation order

Enabled rules sorted by `priority` ASC. All conditions are AND. Matched list feeds the Decision Engine (primary = first match).
