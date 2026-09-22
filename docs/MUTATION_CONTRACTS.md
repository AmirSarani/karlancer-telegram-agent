# Mutation Contracts

## Policy

Production bid/chat/notification-write POSTs go **only** through `VerifiedMutationContract` (`src/api/contracts/verified-mutation.js`).

- Registry starts **empty** in git.
- Missing contract → `blocked_by_missing_api`, **no HTTP POST**.
- Mutations never auto-retry; ambiguous timeout/5xx → `unknown_side_effect` / `needs_reconciliation`.

## HAR-evidenced writes (2026-09-22)

| Capability | Method | Path | Status | Body keys | Auth headers |
|------------|--------|------|--------|-----------|--------------|
| `bids.submit` | POST | `/api/bids` | 201 | `project_id,bid_id,is_pin,is_highlight,is_multi,description,edit_cart_id,milestones[]` | **live:** `Authorization: Bearer`, `Content-Type: application/json` (HAR values stripped; names + live Bearer confirmed) |
| `messages.send` | POST | `/api/messages` | 201 | `receptor_id,room_id,message,file` | same |
| `notifications.mark_read` | POST | `/api/notifications/read` | 200 | `notifications: string[]` | same |
| (public) file | POST | `/api/publics/file` | 200 | (non-JSON / empty keys in export) | public |
| (public) preview | POST | `/api/publics/preview` | 200 | `type,object_id` | public |

## Auth header evidence (fix for stripped HAR)

Live session 2026-09-22 (browser login `POST /api/login/phone` → 200):

- `Authorization: Bearer ${KARLANCER_ACCESS_TOKEN}` on authenticated GETs (`/api/dashboard`, `/api/notifications/`, `/api/profile`)
- Mutation POSTs historically send `Content-Type: application/json` + same Bearer via `KarlancerClient`
- **No** CSRF headers observed
- Contracts remain fail-closed until `configs/verified-mutations.local.json` exists on the operator host

## Enabling locally (operator)

1. Confirm Bearer auth with a private read (`/api/profile`) using env token.
2. Copy `configs/verified-mutations.example.json` → `configs/verified-mutations.local.json` (gitignored).
3. Set `VERIFIED_MUTATION_CONFIG_PATH` if using a custom path.
4. Restart worker/MCP. Boot should log `verified_mutations_loaded` with count 3. Confirm with mocked tests first; never enable live send in CI without mocks.
5. Telegram UX unchanged — plans still require HITL approval. No silent live send.

## Payload schemas (in code)

- `BidPayloadSchema` — HAR milestones shape (adapter maps `price`/`days`/`proposalText` → milestones).
- `MessagePayloadSchema` — `receptor_id` + `room_id` + `message` + `file`.
- `NotificationsReadPayloadSchema` — `{ notifications: string[] }`.

## Telegram UX

Unchanged. Plans still require HITL approval. No silent live send.
