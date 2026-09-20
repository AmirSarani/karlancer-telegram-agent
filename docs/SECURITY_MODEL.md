# Security model

Trust boundaries: MCP host → MCP server → adapters → Karlancer → SQLite → Telegram.

- Authorization is server-side (`requireToolPermission`); the model is not a principal.
- API keys hashed at rest in registry (`sha256`); scopes: read/write/approve/admin.
- SSRF: adapters only call `https://www.karlancer.com` / `karlancer.com`.
- Secrets redacted in logs, audit detail, and Markdown projections.
- Bid/send mutations require explicit approval; no silent auto-submit in default path.
- Untrusted API JSON is data, never instructions.
