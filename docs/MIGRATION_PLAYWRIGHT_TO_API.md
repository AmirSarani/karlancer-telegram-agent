# Migration: Playwright → API

| Before | After |
|--------|-------|
| `playwright` dependency | removed |
| `src/browser/karlancer.js` | `src/legacy/playwright-karlancer.STUB.js` (not imported) |
| storageState login | `KARLANCER_ACCESS_TOKEN` env |
| gotoMessages / screenshot HITL | `messages.list` + Telegram approvals |
| DOM bid/send (extension) | HTTP try-list adapters; blocked if no 2xx |

Guard: `npm run guard:playwright`.
