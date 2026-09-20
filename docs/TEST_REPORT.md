# TEST_REPORT

**Date:** 2026-09-20 (Asia/Tehran)

## Commands

```bash
npm test
npm run test:e2e
npm run guard:playwright
```

## Results (this completion run)

| Suite | Pass | Fail | Skip |
|-------|------|------|------|
| `npm test` (unit/contract/mcp/security/integration) | 62 | 0 | 0 |
| `npm run test:e2e` | 3 | 0 | 1 (live rooms — no `KARLANCER_ACCESS_TOKEN`) |
| `npm run guard:playwright` | OK | — | — |

## Notable mandatory tests

- bid/message mutation timeout → no second POST  
- stale token cache → not `use_cache`  
- claimById wait=true does not steal other jobs  
- heartbeat prevents reclaim  
- approval tamper / replay  
- handoff concurrent writers  
- MCP stdio tools/list + scope deny  
- MCP HTTP auth fail + body 413  
- anon never admin  

## Not run / blocked_external_dependency

- Live authenticated rooms/messages/check-bid (needs operator token on their machine)  
- Live bid/chat POST (blocked_by_missing_api — no verified contract)  
- Live OpenAI calls (optional key; deterministic fallback covered)
