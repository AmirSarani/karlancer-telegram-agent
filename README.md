# Karlancer Telegram / MCP Agent (API-first)

API-first Karlancer agent: **MCP** (stdio + Streamable HTTP), durable **SQLite worker**, optional **Telegram HITL**.  
**No Playwright** in the production path.

## Quick start

```bash
cp .env.example .env
npm ci
ENABLE_TELEGRAM=false npm run worker   # or npm start
npm run mcp                            # Cursor stdio
npm run mcp:http                       # remote HTTP :8787
npm test && npm run guard:playwright
```

Bid/chat **POST** stays `blocked_by_missing_api` until you register a `VerifiedMutationContract` from local HAR evidence (`docs/HAR_CAPTURE.md`). Never paste tokens into chat.

See `IMPLEMENTATION_REPORT.md`, `docs/IMPLEMENTATION_AUDIT.md`, `docs/OPERATIONS.md`.
