# Scoring Model (0–100)

Explainable match score for `ProjectOpportunity`. **Score ≠ permission.**

## Weights (default)

| Factor | Max | Profile input |
|--------|-----|----------------|
| Skills overlap | 30 | `preferredSkills` |
| Budget fit | 20 | `budgetMin` / `budgetMax` |
| Category | 20 | `preferredCategories` |
| Freshness | 15 | `freshHours` (default 24) |
| Client rate | 15 | `clientMinRate` (default 4) |

Reasons are concrete Persian strings with deltas, e.g. `مهارت‌های منطبق: وردپرس (+30)`.

## Profile (SQLite kv)

```js
store.setScoringProfile({
  preferredSkills: ['وردپرس', 'React'],
  preferredCategories: ['6'],
  budgetMin: 5_000_000,
  budgetMax: 50_000_000,
  freshHours: 24,
  clientMinRate: 4,
});
```

`isScoringConfigured(profile)` is true when any preferred skill/category or budget bound is set. The scanner then sets `agent_settings.rules.messageAuto.scoringAvailable` and `bidAuto.scoringAvailable` so PermissionGate auto-rules can turn on when criteria exist.

## API

```js
import { scoreOpportunity, isScoringConfigured } from '../src/opportunity/scoring.js';
const { score, reasons, breakdown } = scoreOpportunity(opportunity, profile);
```
