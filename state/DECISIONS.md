# DECISIONS

## 2026-09-20

- Production bid/chat mutations only via VerifiedMutationContract; extension try-lists are documentation for HAR only.
- ENABLE_TELEGRAM=false must allow MCP/worker without Telegram token.
- MCP_ALLOW_ANON never grants admin.
- Intelligence returns insufficient_data rather than fake ML confidence.

## 2026-09-20 interim

- Prefer scp or stdin for Karlancer JWT; never unquoted bash source into .env.
- If box lacks token, finish docs and report — do not wait forever.
- Keep PR #1 unmerged; bid/chat blocked until HAR contract.
- Do not commit LIVE_SCAN.json to the public repo.
