# Auth Flow (Karlancer)

## Tokens

| Source | Env | Client usage |
|--------|-----|--------------|
| Access token | `KARLANCER_ACCESS_TOKEN` | `Authorization: Bearer <token>` |
| Cookie (optional) | `KARLANCER_COOKIE` | `Cookie: …` |

Hot reload: `client.setAccessToken(token)` / `setCookie` (no process restart).

## HAR findings (2026-09-22)

1. **No refresh endpoint** observed across both HAR captures.
2. Exported HAR **did not include** `Authorization`, `Cookie`, or CSRF header values (Chrome redaction).
3. Authenticated GETs/POSTs still succeeded in-browser during capture → auth is almost certainly Bearer (and/or cookie) applied by the SPA, matching this client.

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

1. Log into karlancer.com in a browser you control.
2. Copy access token from `localStorage` (see existing CONNECTING docs) — **never paste into chat/git**.
3. Set `KARLANCER_ACCESS_TOKEN` on the VPS/agent host.
4. Optionally call MCP health / `user.profile` to verify.

## CSRF / cookies

Documented carefully: HARs show **no** `X-XSRF-TOKEN` / `X-CSRF-TOKEN` on API calls in the export. If future captures show CSRF requirements, document before enabling mutations.

## Tenant isolation

MCP/worker continue to scope jobs and credentials per tenant. Tokens must never appear in logs (redaction middleware preserved).
