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
| POST | `/api/login/phone` | `phone`, `password`, `unregistered_project_token`, `unregistered_service_token`, `role` | 200 |

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


## Telegram re-login (owner-only)

Owners can renew the session from **Settings → 🔐 تمدید نشست** without SSHing:

1. Bot asks for phone, then password (in-memory conversation state, 10‑minute timeout, cancel button).
2. Calls `POST /api/login/phone` with the live body shape above (`auth: false`).
3. Parses `data.access_token`, hot-swaps `client.setAccessToken`, updates `process.env.KARLANCER_ACCESS_TOKEN`, and rewrites `.env` with the same safe pattern as `deploy/scripts/install-karlancer-token.sh` (never bash-source a token containing `|`).
4. Deletes the password (and phone) Telegram messages when possible. Success text: «نشست تازه فعال شد» — **never** echoes the token.
5. Password is never written to disk/DB/logs. Chat history may still retain copies — prefer rotating the Karlancer password if it was typed in Telegram.

On API `401`/`403` from reads, owners get a rate-limited soft notify to renew from Settings.


## Transport & secrets hardening (honest constraints)

### What TLS covers

| Hop | Protection |
|-----|------------|
| User ↔ Telegram clients | Telegram client protocols (MTProto for user apps) |
| Bot process ↔ `api.telegram.org` | **HTTPS only** (Grammy default; optional `TELEGRAM_API_ROOT` must be `https://`) |
| Agent ↔ `www.karlancer.com` | **HTTPS only** — `KARLANCER_BASE_URL` / client reject `http://` |
| Agent ↔ OpenAI-compatible LLM | **HTTPS only** — `OPENAI_BASE_URL` rejects `http://` |

### What is NOT end-to-end encrypted

**Telegram Bot API messages are NOT E2E.** محتوایی که کاربر به ربات می‌فرستد (از جمله شماره/رمز هنگام تمدید نشست) روی سرورهای تلگرام قابل خواندن است. ما نمی‌توانیم روی بدنهٔ پیام‌های Bot API رمزنگاری واقعی E2E اضافه کنیم.

این ایجنت فقط سخت‌سازی می‌کند: HTTPS خروجی، رمزنگاری موقت شماره در حافظهٔ فرایند، حذف پیام رمز در چت وقتی API اجازه دهد، و redaction لاگ — **نه** ادعای E2E.

### Ephemeral re-login encryption

- Phone (while awaiting password) is stored as AES-256-GCM ciphertext in an in-memory Map only (`TELEGRAM_SECRETS_KEY` or derived from bot token / credential secret).
- Password is never written to disk/SQLite; used only for the HTTPS `POST /api/login/phone` call, then dropped.
- Plaintext must never appear in logs (see `src/security/redaction.js`).

### At-rest access token

- `KARLANCER_ACCESS_TOKEN` lives in `.env` with mode `600` via `persistAccessToken` / install script.
- Prefer **not** encrypting the systemd `EnvironmentFile` token further (would break `EnvironmentFile=` loading). Do not store the token in SQLite or logs.
- Optional per-tenant ciphertext path remains `KARLANCER_CREDENTIAL_KEK` (see OPERATIONS.md).

Generate secrets key on VPS (never print to chat):

```bash
# on VPS, as deploy user — value goes only into .env
KEY=$(openssl rand -hex 32)
# merge TELEGRAM_SECRETS_KEY=$KEY into /opt/karlancer-telegram-agent/.env (chmod 600)
unset KEY
```


## Preferred reauth (Phase 6) — browser token paste

Telegram Bot API is **not** E2E. Prefer **not** typing the Karlancer password in chat.

1. Settings → **🔐 تمدید نشست**
2. Choose **📋 توکن مرورگر** (recommended)
3. From logged-in browser: DevTools → Application → Local Storage → `auth-token` → copy `access_token`
4. Paste **only** that token in the bot; message is deleted when possible
5. Fallback **⚠️ ورود با رمز** keeps the phone/password flow with an explicit warning

### Session health

`src/security/session-health.js` periodically probes `GET /api/profile` (dashboard/me fallback). On 401, **all** owner chat ids are notified (cooldown 30m) with CTA to renew via token paste.
