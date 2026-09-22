# Connecting clients

## Cursor (stdio)

See `configs/cursor-mcp.json.example`.

```bash
export KARLANCER_ACCESS_TOKEN='...' # localStorage auth-token.access_token (quote: token contains |)
export MCP_API_KEY=dev-local        # for HTTP mode
npm run mcp
```

## Streamable HTTP

```bash
MCP_API_KEY=dev-local MCP_ALLOW_ANON=false npm run mcp:http
# Health (no auth): GET http://127.0.0.1:8787/health
# MCP: POST http://127.0.0.1:8787/mcp  Authorization: Bearer dev-local
```

## Telegram

```bash
cp .env.example .env   # set TELEGRAM_* and KARLANCER_ACCESS_TOKEN
npm start              # bot + embedded worker
```

## Env reference

See `configs/mcp.env.example` and `.env.example`.
