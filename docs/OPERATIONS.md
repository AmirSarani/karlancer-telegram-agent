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

Single-node SQLite enforced via `single_node_lock` — do not scale multiple writers on one volume.

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
