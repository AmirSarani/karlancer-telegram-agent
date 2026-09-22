# API Catalog (Karlancer)

Base: `https://www.karlancer.com`

See **[KARLANCER_API_MAP.md](./KARLANCER_API_MAP.md)** for the HAR-backed full map.

| Method | Path | Auth | Status |
|--------|------|------|--------|
| POST | `/api/login/phone` | public (returns Bearer) | confirmed 2026-09-22 |
| GET | `/api/rooms/?page=` | Bearer | confirmed |
| GET | `/api/rooms/archive?page=` | Bearer | HAR |
| GET | `/api/rooms/{id}/messages-pg?page=` | Bearer | confirmed |
| POST | `/api/messages` | Bearer | HAR 201 (contract gated) |
| GET | `/api/check-bid?projectIds[i]=` | Bearer | confirmed |
| POST | `/api/bids` | Bearer | HAR 201 (contract gated) |
| GET | `/api/dashboard` | Bearer | HAR |
| GET | `/api/notifications/` | Bearer | HAR |
| POST | `/api/notifications/read` | Bearer | HAR (contract gated) |
| GET | `/api/bookmarks/project/ids` | Bearer | HAR |
| GET | `/api/bookmarks/freelancer/ids` | Bearer | HAR |
| GET | `/api/plans` | Bearer | HAR |
| GET | `/api/publics/projects/{id\|slug}` | public | confirmed |
| GET | `/api/publics/search/projects` | public | HAR |
| GET | `/api/publics/suggest/project/{id}` | public | HAR |

Auth: `Authorization: Bearer <access_token>` from env (HAR export stripped header values).
