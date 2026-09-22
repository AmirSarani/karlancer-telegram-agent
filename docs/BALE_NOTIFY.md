# Bale parallel notify (optional)

Telegram remains the primary owner channel. Bale is an **optional parallel** fan-out.

## Config

```bash
# Optional — if unset, Bale is skipped (stub / no-op)
BALE_BOT_TOKEN=
# Comma-separated; defaults to TELEGRAM_OWNER_CHAT_ID list when empty
BALE_OWNER_CHAT_IDS=
# Default Telegram-compatible Bale API
BALE_API_ROOT=https://tapi.bale.ai
```

## Behaviour

- `src/telegram/bale-notify.js` → `notifyBaleOwners`
- Called from `notifyAllOwnersChannels` in `src/index.js` for opportunity / digest / session-401 style alerts
- If `BALE_BOT_TOKEN` is missing → `{ skipped: true }` — **Telegram path unchanged**
- Secrets never logged (redaction applied to error strings)

## Setup

1. Create a Bale bot and obtain token.
2. Message the bot once; set chat id(s) in `BALE_OWNER_CHAT_IDS`.
3. Restart agent. Boot log shows `bale: true|false`.

## Notes

Bale Bot API is largely Telegram-compatible (`sendMessage`). Inline keyboards / advanced UX may differ — this integration only sends plain text alerts.
