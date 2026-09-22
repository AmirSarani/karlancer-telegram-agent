# MCP_PRODUCTION

SDK: `@modelcontextprotocol/sdk@1.12.1` (pinned)

## Transports

| Transport | Entry | Auth |
|-----------|-------|------|
| stdio | `npm run mcp` → `src/mcp/stdio-entry.js` | local process |
| Streamable HTTP | `npm run mcp:http` → `src/mcp/http-entry.js` | Bearer / `X-API-Key` |

Cursor example: `configs/cursor-mcp.json.example`  
Remote HTTP example: `configs/mcp-http.example.json`

## Security

- Auth required before MCP discovery (except `/health` public liveness)
- `MCP_ALLOW_ANON=true` → scopes `['read']` only — **never admin**
- Session ID bound to API key hash (`mcp_sessions`); possession alone insufficient
- Body size limit (`MCP_MAX_BODY_BYTES`), request timeout, rate limit, optional CORS origin allowlist
- Tool scopes: read / write / approve / admin

## Tools (selected)

Read: `health.get`, `rooms.list`, `project.get`, `room.messages`, `bids.check`, `memory.search`, `job.get_status`, `pricing.get_recommendation`, `intelligence.get_insight`  
Plan: `bids.submit_plan`, `messages.send_plan`, `project.analyze_plan`, `proposal.draft_plan`  
Approval: `approvals.list|get|decide`, `job.cancel`
