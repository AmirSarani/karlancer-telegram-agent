# SECURITY_REVIEW

| Area | Control | Test |
|------|---------|------|
| SSRF | `assertAllowedUrl` https + karlancer hosts only | hardening.test.js |
| Secret leakage | `redactDeep` / logger | redaction.test.js |
| API key scopes | hash registry + per-tool permission | hardening + anon-mcp |
| Session hijack | session↔keyHash bind | anon-mcp.test.js |
| Tenant isolation | job list/get tenant checks | hardening |
| Path traversal | resources resolve under base | resources.js |
| SQLi | parameterized LIKE + escape | hardening |
| Oversized body | 413 on MCP HTTP | http-protocol |
| Rate limit | token bucket client + HTTP | client + http-entry |
| Telegram owner | exact chat id | hardening + bot.js |
| Replay approval | atomic pending→decided | queue + hardening |
| Duplicate mutation | idempotency keys + no retry on unknown | mutation-timeout |
| Upstream errors | sanitized body in errors | client.js |

Prompt injection: employer/LLM text treated as untrusted data; system prompts instruct not to follow embedded instructions.
