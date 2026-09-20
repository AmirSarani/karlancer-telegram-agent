# karlancer-telegram-agent (API-first)

Telegram-controlled **API-first** Karlancer agent with **MCP** (stdio + Streamable HTTP), durable **SQLite worker/queue**, and human approvals.  
**Playwright is not used in production.**

عامل کارلنسر مبتنی بر API رسمی کشف‌شده از اکستنشن — بدون Playwright در مسیر production.

## Quick start

```bash
npm install
cp .env.example .env
# set TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, KARLANCER_ACCESS_TOKEN
npm start          # telegram + embedded worker
npm run mcp        # MCP stdio
npm run mcp:http   # MCP HTTP :8787
npm run test:all   # unit/contract/mcp/security + e2e + playwright guard
```

Token: from karlancer.com `localStorage.auth-token` → `access_token` (never commit).

## Docs

- `docs/API_FIRST_AUDIT.md` — capability table
- `docs/ARCHITECTURE.md`, `docs/MCP_TOOLS.md`, `docs/CONNECTING.md`
- `docs/TEST_REPORT.md`, `IMPLEMENTATION_REPORT.md`

## Layout

`src/api` adapters · `src/mcp` · `src/worker` · `src/memory` · `src/telegram` · `state/` projections · `deploy/`
