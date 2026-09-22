# Karlancer API Map (from HAR)

**Sources (private, not committed):**  
- HAR1 sha256 `3cf00cd25999ea1b47ea94659a044b041ac9f3e55522f0e275ccb6a07a30ca99` (14.6MB, 287 entries)  
- HAR2 sha256 `92f1c95bdc021d7d7870d45d7aac582e23b9408f2fd9c5e9c80366f396fbe35f` (7.3MB, 151 entries)

**Domains:** `www.karlancer.com` (API/HTML), `cdn.karlancer.com` (static).  
**Base:** `https://www.karlancer.com`  
**Envelope:** typically `{ status, data, error }`.

> Security: Chrome HAR export **stripped** `Authorization` / `Cookie` / CSRF headers. Do **not** treat HARs as complete auth evidence. Never commit raw HARs or tokens.

## Inventory summary

| Class | Count (unique paths, normalized) | Notes |
|-------|----------------------------------|-------|
| API JSON | ~20 logical endpoints | plus many `/api/file/seoContents/*` public assets |
| Mutations with 2xx | 5 | bids, messages, notifications/read, publics/file, publics/preview |
| Refresh/token endpoints | **0** | no refresh observed |

## Auth / session

| Item | Evidence |
|------|----------|
| Access token | App expects `KARLANCER_ACCESS_TOKEN` → `Authorization: Bearer …` (existing client) |
| Cookie | Optional `KARLANCER_COOKIE` |
| Refresh | **Not observed** in HAR |
| CSRF headers | **Not present** in exported HAR request headers |
| 401 handling | Client maps 401/403 → `unauthorized`; no auto-refresh |

## Endpoints (logical)

### Auth / user / dashboard
| Method | Path | Auth | R/W | Purpose | MCP |
|--------|------|------|-----|---------|-----|
| GET | `/api/dashboard` | yes* | R | Wallet + user profile summary | `user.profile`, `dashboard.get`, resource `karlancer://profile` |

\*Auth required in practice; HAR lacked auth header bytes.

### Conversations / messaging
| Method | Path | Auth | R/W | Purpose | MCP |
|--------|------|------|-----|---------|-----|
| GET | `/api/rooms/?page=` | yes* | R | Active rooms (Laravel page) | `rooms.list`, `conversations.list`, resource `karlancer://conversations` |
| GET | `/api/rooms/archive?page=` | yes* | R | Archived rooms | `conversations.list_archived` |
| GET | `/api/rooms/{id}/messages-pg?page=` | yes* | R | Messages + room meta | `room.messages`, `conversations.messages` |
| POST | `/api/messages` | yes* | **W** | Send message | gated `messages.send` / `messages.send_plan` |
| GET | `/api/freelancer-room/employer/{id}` | yes* | R | Employer room lookup | (adapter-ready; not primary MCP yet) |

**Send body (HAR 201):** `{ receptor_id, room_id, message, file }`  
`file` may be `""` or `{ name, url, size, type }`.

### Projects / search
| Method | Path | Auth | R/W | Purpose | MCP |
|--------|------|------|-----|---------|-----|
| GET | `/api/publics/projects/{id\|slug}` | public | R | Resolve/detail (pre-existing) | `project.get` |
| GET | `/api/publics/search/projects` | public | R | Project search | `projects.search` |
| GET | `/api/publics/suggest/project/{id}` | public | R | Related projects | `projects.suggest` |
| GET | `/api/publics/category-page` | public | R | Category landing | via `search.categoryPage` |
| POST | `/api/publics/preview` | public? | W | Preview ping `{ type, object_id }` | documented only |
| GET | `/api/check-bid?projectIds[i]=` | yes* | R | Bid already submitted? | `bids.check` |

### Bids
| Method | Path | Auth | R/W | Purpose | MCP |
|--------|------|------|-----|---------|-----|
| POST | `/api/bids` | yes* | **W** | Submit bid | gated `bids.submit` / `bids.submit_plan` |

**Bid body (HAR 201):**  
`{ project_id, bid_id, is_pin, is_highlight, is_multi, description, edit_cart_id, milestones:[{ description, duration, budget }] }`  
Note: price/duration live in **milestones**, not top-level `bid_price`.

### Notifications
| Method | Path | Auth | R/W | Purpose | MCP |
|--------|------|------|-----|---------|-----|
| GET | `/api/notifications/` | yes* | R | Alerts + notification list | `notifications.list`, resource `karlancer://notifications` |
| POST | `/api/notifications/read` | yes* | **W** | Mark read `{ notifications: string[] }` | gated `notifications.mark_read` |

### Bookmarks / plans / files
| Method | Path | Auth | R/W | Purpose | MCP |
|--------|------|------|-----|---------|-----|
| GET | `/api/bookmarks/project/ids` | yes* | R | Bookmarked projects | `bookmarks.projects` |
| GET | `/api/bookmarks/freelancer/ids` | yes* | R | Bookmarked freelancers | `bookmarks.freelancers` |
| GET | `/api/plans` | yes* | R | User plans / bid credits | `plans.list` |
| GET | `/api/plans/{id}/skills` | yes* | R | Plan skills (+ worksamples) | adapter `plans.skills` |
| GET | `/api/file/seoContents/{file}` | public | R | SEO/marketing images | `files.seo_meta` (path hint only) |
| POST | `/api/publics/file` | ? | W | Upload/public file | **not enabled** |

## Response shapes (normalized by adapters)

Adapters return **normalized** objects (`id`, `lastMessage`, `pagination`, …) and may include `raw` for debugging — MCP tools strip `raw` before returning.

## Pagination

Laravel-style: `current_page`, `last_page`, `per_page`, `total`, `data[]`.  
Helpers: `src/api/util/pagination.js` (`normalizePagination`, `extractLaravelPage`, `iteratePages`).

## Mutations policy

See [MUTATION_CONTRACTS.md](./MUTATION_CONTRACTS.md). Live POST for bid/chat remains **fail-closed** until a local VerifiedMutationContract is registered with complete evidence (including auth).
