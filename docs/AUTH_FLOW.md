# Auth Flow (Karlancer)

## Tokens

| Source | Env | Client usage |
|--------|-----|--------------|
| Access token | `KARLANCER_ACCESS_TOKEN` | `Authorization: Bearer <token>` |
| Cookie (optional) | `KARLANCER_COOKIE` | `Cookie: …` |

Hot reload: `client.setAccessToken(token)` / `setCookie` (no process restart).

Token format (observed): Laravel Sanctum-style `numericId|secret` (not a JWT). Store **single-quoted** in bash `.env` files because `|` breaks unquoted shell assignment. systemd `EnvironmentFile` accepts the raw value without quotes.

## Login (API)

| Method | Path | Body keys | Status |
|--------|------|-----------|--------|
| POST | `/api/login/phone` | `phone`, `password`, `role`, `unregistered_project_token`, `unregistered_service_token` | 200 |

Response `data` includes `access_token`, `token_type` (`Bearer`), `user`, …  
Browser also stores `localStorage["auth-token"]` = `{ token_type, access_token, refresh_token, is_token_valid }`.  
**No refresh endpoint** observed; `refresh_token` was empty after login (2026-09-22).

## HAR + live findings (2026-09-22)

1. **No refresh endpoint** observed across HAR captures.
2. Exported HAR **did not include** `Authorization` / `Cookie` / CSRF header **values** (Chrome redaction). Header **names** on mutations still showed `content-type` (+ browser CORS headers); no `x-csrf-token` / `x-xsrf-token`.
3. Live browser login + authenticated GETs confirmed wire auth:
   - Request header: `Authorization: Bearer <access_token>`
   - Request header (POSTs): `Content-Type: application/json`
   - Response CORS: `access-control-allow-headers: Content-Type, Authorization`
4. Authenticated GETs used for confirmation (no mutation side effects): `/api/profile`, `/api/dashboard`, `/api/notifications/`, `/api/rooms/`.

## Lifecycle

```
env token/cookie → KarlancerClient headers → request
        │
        ├─ 2xx → return JSON
        ├─ 401/403 → KarlancerApiError(unauthorized) — no retry, no refresh
        ├─ 429 → retry (reads only)
        └─ 5xx/timeout → retry (reads only); mutations never auto-retry
```

## Operator rotation

1. Prefer `POST /api/login/phone` (or browser login) from a private operator host — **never paste tokens/passwords into chat/git**.
2. Copy `access_token` from login response or `localStorage["auth-token"].access_token`.
3. Set `KARLANCER_ACCESS_TOKEN` on the VPS/agent host (quote for bash if using `source`).
4. Confirm with `user.profile` / MCP health / boot log `auth: true`.

## CSRF / cookies

HARs + live capture show **no** `X-XSRF-TOKEN` / `X-CSRF-TOKEN` on API calls. Bearer alone is sufficient for reads. Mutations use the same client header path.

## Tenant isolation

MCP/worker continue to scope jobs and credentials per tenant. Tokens must never appear in logs (redaction middleware preserved).
