# OPERATIONS

## Local

```bash
cp .env.example .env   # fill secrets locally — never commit
npm ci
ENABLE_TELEGRAM=false npm start   # worker/scheduler headless
npm run worker                    # standalone worker
npm run mcp                       # stdio
npm run mcp:http                  # HTTP :8787
npm test && npm run test:e2e && npm run guard:playwright
```

## Docker

```bash
cd deploy && docker compose up -d --build
# Telegram profile optional: docker compose --profile telegram up -d
```

Single-node SQLite enforced via `acquireSingleNodeLock` with **periodic heartbeat** (default every ≤30s; stale reclaim at 2 min). Wire-up: `src/index.js` and `src/worker/runner.js` call `startHeartbeat()` after acquire and `release()` on shutdown. Do not run multiple writers on one volume.

## Backup / restore

```bash
npm run backup
bash deploy/scripts/restore-sqlite.sh data/backups/agent-XXXX.sqlite
```

## Token rotation

Set `KARLANCER_ACCESS_TOKEN` in env/secret manager and restart worker **or** call `client.setAccessToken` via a future admin hook. Never paste token in Telegram chat.

## Rollback

1. `git checkout <previous-sha>`
2. Restore SQLite backup
3. Redeploy compose / systemd units in `deploy/`

## Karlancer credential model

**Current default: SHARED.** Process-level `KARLANCER_ACCESS_TOKEN` / `KARLANCER_COOKIE` is used for all tenants (`source: shared_env`).

**Optional per-tenant (encrypted at rest):** set `KARLANCER_CREDENTIAL_KEK` (32-byte base64) or `KARLANCER_CREDENTIAL_SECRET`, then store per-tenant ciphertext via `upsertTenantCredential` (`src/security/tenant-credentials.js`). Resolution order: tenant ciphertext → shared env → none.

## SQLite lock (truthful)

`acquireSingleWorkerConsumerLock` (alias: `acquireSingleNodeLock`) is a **single-worker-consumer / single-writer** lock. Multi-writer on one SQLite file is **not** supported. Run one writer/consumer per DB volume; use heartbeat so stale holders can be reclaimed.

## MCP HTTP sessions

- TTL: `MCP_SESSION_TTL_MS` (default 30m)
- Cleanup interval: `MCP_SESSION_CLEANUP_INTERVAL_MS` (default 60s)
- Max sessions: `MCP_MAX_SESSIONS` (default 100); excess → 429 `session_limit_exceeded`
- Shutdown (SIGINT/SIGTERM) closes transports and deletes session rows


## Daily backup (VPS)

```bash
# one-shot
cd /opt/karlancer-telegram-agent && bash deploy/scripts/daily-backup.sh

# install cron (~03:15)
bash scripts/install-daily-backup-cron.sh /opt/karlancer-telegram-agent
```

Backups land in `data/backups/daily-TIMESTAMP/` (mode 700) with `agent.sqlite` + `.env` copy (`chmod 600`) or `env.gpg` if `BACKUP_GPG_RECIPIENT` is set.

Restore:

```bash
systemctl stop karlancer-telegram-agent
bash deploy/scripts/restore-from-daily.sh data/backups/daily-YYYYMMDDTHHMMSS
systemctl start karlancer-telegram-agent
```

Secret rotation: see `scripts/rotate-secrets.md` (agent cannot rotate Karlancer password / bot token / root for you).
