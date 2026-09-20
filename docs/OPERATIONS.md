# Operations / RUNBOOK

## Processes

| Process | Command |
|---------|---------|
| Telegram + embedded worker | `npm start` |
| Worker only | `npm run worker` |
| MCP stdio | `npm run mcp` |
| MCP HTTP | `npm run mcp:http` |

## Health

- `GET /health` on MCP HTTP port
- Telegram `/status`

## Backup

```bash
cp data/agent.sqlite data/agent.sqlite.bak-$(date +%Y%m%d)
```

Restore: stop processes, replace file, restart. Run `npm run test:e2e` after restore in staging.

## Deploy

See `deploy/docker-compose.yml` and `deploy/systemd/`.

## Incident

1. `/pause` on Telegram  
2. Inspect `jobs` with status `failed` / `needs_reconciliation`  
3. Rotate `KARLANCER_ACCESS_TOKEN` if 401  
4. Never retry blind mutations — reconcile with `bids.check` first  
