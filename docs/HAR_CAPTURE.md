# Secure local HAR capture (operator machine)

Use this **only on your own logged-in browser** to discover the real bid/chat POST contract.  
**Never** paste `access_token`, cookies, Authorization headers, or HAR files containing secrets into Chat, GitHub issues, PRs, or commits.

## Steps

1. Open Chrome → log into `https://www.karlancer.com`.
2. DevTools → **Network** → enable **Preserve log**.
3. Perform **one** successful bid submit (or chat send) via the normal UI / official extension.
4. Find the `POST` to `www.karlancer.com/api/...` with status **2xx**.
5. Right-click → Copy → Copy as cURL (sanitize) **or** export HAR and **redact**:
   - `Authorization`
   - `Cookie`
   - any `access_token` / localStorage dumps
6. Record locally (private notes): method, path, request JSON keys, response status, response JSON shape.
7. Optionally set `VERIFIED_MUTATION_CONFIG_PATH` to a **gitignored** JSON that calls `registerVerifiedMutation` (see `src/api/contracts/verified-mutation.js`). Do not commit that file.

## Candidate paths (guidance only — not attempted by agent)

Bid (extension try-list, unverified): `/api/bids`, `/api/projects/bid`, `/api/projects/{id}/bids`  
Chat: `/api/rooms/{id}/messages`, `/api/rooms/{id}/message`, `/api/messages`, `/api/rooms/messages`

Until a redacted contract is registered, the agent returns `blocked_by_missing_api` and **does not POST**.
