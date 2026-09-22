# Mutation Contracts

## Policy

Production bid/chat/notification-write POSTs go **only** through `VerifiedMutationContract` (`src/api/contracts/verified-mutation.js`).

- Registry starts **empty** in git.
- Missing contract → `blocked_by_missing_api`, **no HTTP POST**.
- Mutations never auto-retry; ambiguous timeout/5xx → `unknown_side_effect` / `needs_reconciliation`.

## HAR-evidenced writes (2026-09-22)

| Capability | Method | Path | Status | Body keys | Auth headers in HAR |
|------------|--------|------|--------|-----------|---------------------|
| `bids.submit` | POST | `/api/bids` | 201 | `project_id,bid_id,is_pin,is_highlight,is_multi,description,edit_cart_id,milestones[]` | **stripped** |
| `messages.send` | POST | `/api/messages` | 201 | `receptor_id,room_id,message,file` | **stripped** |
| `notifications.mark_read` | POST | `/api/notifications/read` | 200 | `notifications: string[]` | **stripped** |
| (public) file | POST | `/api/publics/file` | 200 | (non-JSON / empty keys in export) | stripped |
| (public) preview | POST | `/api/publics/preview` | 200 | `type,object_id` | stripped |

## Why live send/bid stay disabled

Mission rule: register only with **complete** method/URL/**headers**/body evidence.  
Chrome HAR export omitted auth headers → we **scaffold** schemas + example config, but do **not** auto-register.

## Enabling locally (operator)

1. Re-capture one successful bid/send with headers preserved **or** confirm Bearer-only auth works via curl using env token (private).
2. Copy `configs/verified-mutations.example.json` → `configs/verified-mutations.local.json` (gitignored).
3. Set `VERIFIED_MUTATION_CONFIG_PATH` if using a custom path.
4. Restart worker/MCP. Confirm with mocked tests first; never enable live send in CI without mocks.

## Payload schemas (in code)

- `BidPayloadSchema` — HAR milestones shape (adapter maps `price`/`days`/`proposalText` → milestones).
- `MessagePayloadSchema` — `receptor_id` + `room_id` + `message` + `file`.
- `NotificationsReadPayloadSchema` — `{ notifications: string[] }`.

## Telegram UX

Unchanged. Plans still require HITL approval. No silent live send.
