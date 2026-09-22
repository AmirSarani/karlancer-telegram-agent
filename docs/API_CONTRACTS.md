# API_CONTRACTS

## Confirmed reads

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/rooms/?page={n}` | Bearer | pagination meta best-effort |
| GET | `/api/rooms/{id}/messages-pg?page={n}` | Bearer | `data.messages.data[]` |
| GET | `/api/check-bid?projectIds[i]=` | Bearer | `data.has_submitted_bid` |
| GET | `/api/publics/projects/{id}` | public | `data` = slug string |
| GET | `/api/publics/projects/{slug}` | public | project object |

## Mutations

Only `VerifiedMutationContract` (`src/api/contracts/verified-mutation.js`).  
Registry starts **empty**. Production bid/chat POST is disabled until HAR evidence registers a contract.

## Client behavior

- Reads: timeout, retry with backoff+jitter, rate limit, circuit breaker
- Mutations: `retries=0`; timeout/5xx after send → `unknown_side_effect` / `needs_reconciliation`; **no auto-retry POST**
- `tryPost` throws unless `allowMutationDiscovery=true` (forbidden for bid/chat)
