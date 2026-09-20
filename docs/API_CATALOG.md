# API Catalog (Karlancer)

Base: `https://www.karlancer.com`

| Method | Path | Auth | Status |
|--------|------|------|--------|
| GET | `/api/rooms/?page=` | Bearer | confirmed (extension) |
| GET | `/api/rooms/{id}/messages-pg?page=` | Bearer | confirmed |
| GET | `/api/check-bid?projectIds[0]=` | Bearer | confirmed |
| GET | `/api/publics/projects/{id}` | public | confirmed |
| GET | `/api/publics/projects/{slug}` | public | confirmed |
| POST | `/api/bids` (+ variants) | Bearer | **unverified** try-list |
| POST | `/api/rooms/{id}/messages` (+ variants) | Bearer | **unverified** try-list |
| GET | `/api/user` (+ variants) | Bearer | try-list |

Auth header: `Authorization: Bearer <access_token>` from `localStorage.auth-token`.
