# karlancer-telegram-agent

Telegram-controlled autonomous agent for [Karlancer](https://www.karlancer.com) (Iranian freelancing).  
**Not a Chrome extension** — the owner drives the agent via Telegram; Playwright will later automate the browser.

عامل مستقل کارلنسر با کنترل از تلگرام (نه افزونه کروم). مالک از طریق بات دستور می‌دهد؛ بعداً مرورگر با Playwright به karlancer.com وصل می‌شود.

---

## Architecture / معماری

```
Telegram (owner) ──long poll──► Node bot (grammY)
                                    │
                                    ├─► agent/prompts + memory (JSON per room)
                                    └─► browser/karlancer.js (Playwright stubs)
                                              │
                                              ▼
                                        karlancer.com
```

| Piece | Role |
|-------|------|
| `src/telegram/bot.js` | Owner-only commands, long polling |
| `src/agent/prompts.js` | Iran-aware Persian freelancer prompts |
| `src/agent/memory.js` | Per-`roomId` JSON conversation context |
| `src/browser/karlancer.js` | Playwright: launch / messages / screenshot (stubs) |
| `src/index.js` | Starts bot; browser optional later |

---

## Setup / راه‌اندازی

### 1. Clone & install

```bash
git clone https://github.com/AmirSarani/karlancer-telegram-agent.git
cd karlancer-telegram-agent
npm install
```

### 2. Bot token

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy token.
2. Copy env file:

```bash
cp .env.example .env
```

3. Set `TELEGRAM_BOT_TOKEN` in `.env`.

### 3. Owner chat id (مهم)

**Message the bot once** (`/start`), set `TELEGRAM_OWNER_CHAT_ID` to your numeric chat id, then run `npm start`.

فارسی: یک‌بار به بات پیام بدهید (`/start`)، مقدار `chat id` را در `TELEGRAM_OWNER_CHAT_ID` بگذارید، بعد `npm start`.

The bot replies with your chat id if you are not yet the configured owner.

### 4. Optional LLM / Playwright

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
KARLANCER_STORAGE_STATE_PATH=./storage/karlancer-storage-state.json
```

```bash
npx playwright install chromium   # when you start using the browser module
```

### 5. Run

```bash
npm start
# or: npm run bot
```

---

## Telegram commands / دستورات

| Command | Description |
|---------|-------------|
| `/start` | Welcome + chat id hint |
| `/help` | Command list |
| `/status` | running/paused + simple stats |
| `/pause` | Pause autonomous work |
| `/resume` | Resume |
| `/approve` | HITL approve (stub) |
| `/reject` | HITL reject (stub) |

Only `TELEGRAM_OWNER_CHAT_ID` can use control commands.

---

## Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | BotFather token |
| `TELEGRAM_OWNER_CHAT_ID` | yes (for control) | Your Telegram user/chat id |
| `OPENAI_API_KEY` | no (MVP) | OpenAI-compatible key |
| `OPENAI_BASE_URL` | no | Default `https://api.openai.com/v1` |
| `KARLANCER_STORAGE_STATE_PATH` | no | Playwright `storageState` JSON path |

**No secrets in the repo.** Use `.env` locally (gitignored).

---

## Prompts (agent)

`src/agent/prompts.js` includes:

- Human Persian freelancer tone (anti-robot)
- Honest constraints: **PWA vs native iOS / App Store** (Iran reality)
- Stage-based pricing explanation (discovery → MVP → later phases)
- Analyze / write proposal / reply system prompts

---

## Playwright login (next steps)

1. Run headed Chromium once (set `HEADLESS=false`).
2. `launch()` → open `https://www.karlancer.com` → log in manually.
3. Call `saveStorageStateAfterManualLogin()` → writes `KARLANCER_STORAGE_STATE_PATH`.
4. Later runs reuse that storage state (no password in repo).
5. Port invitation/messages API or DOM selectors from the Chrome extension (`karlancer-ext`) into `gotoMessages` and future bid helpers.
6. Wire Telegram `/approve` / `/reject` to pending HITL drafts before any auto-submit.

---

## License

Private — AmirSarani.
