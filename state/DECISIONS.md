# DECISIONS

## 2026-09-20

- Production bid/chat mutations only via VerifiedMutationContract; extension try-lists are documentation for HAR only.
- ENABLE_TELEGRAM=false must allow MCP/worker without Telegram token.
- MCP_ALLOW_ANON never grants admin.
- Intelligence returns insufficient_data rather than fake ML confidence.
