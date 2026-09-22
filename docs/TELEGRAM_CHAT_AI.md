# Telegram Chat AI — engagement continuum

Persian UX modes for inbound Karlancer chats. **Never unlimited auto-send.**

## Modes (`chatAiMode`)

| Mode | Persian | Behavior |
|------|---------|----------|
| `full_manual` | کاملاً دستی | Notify only (optional light summary on continuum). Owner opens chat and triggers analyze/draft. |
| `pick_to_answer` | انتخابی | On inbound: LLM analyze + draft + **internal** price → Telegram card «جواب بدم؟». Only picked chats proceed to HITL send. |
| `full_auto` | خودکار | LLM + PermissionGate + `messageAuto` rules + daily limits + `ALLOW_LIVE_AUTO_SEND`. First-N approval preview, emergency stop, blacklist. Falls back to pick/HITL when gated. |

Set in **Settings → حالت AI گفتگو** (`nav:chatmode`) or control panel / AI rules.

Execution mode (`manual` / `assisted` / `auto`) stays separate; chat AI mode only governs the **inbound chat reply pipeline**.

## Answered section

✅ **جواب‌داده‌شده‌ها** (`goto:answered`): rooms marked answered after successful send or owner «بررسی شد / جواب داده شد».

Room thread phase: `new` → `pending` → `answered` → `active_thread` (when they message again).

## Continuum / memory (SQLite)

Per-room KV `room:{id}:thread`:

- `phase`, `summary`, `lastSentText`, `lastDraftText`
- `lastSentAt`, `lastInboundAt`, `notes`, `suggestedPrice`

On new inbound for an answered/active thread: reload context → re-analyze with LLM → notify per mode.

## Poll upgrade

`messages.poll` → `createChatContinuum.processPollCards`:

1. Detect fresh inbound (existing poll)
2. Mode-aware pipeline (manual / pick / auto)
3. Reuses `analyzeRoomWithLlm`, `adaptDraftWithNote`, `cleanHumanReply`, PermissionGate, mutation requester, VerifiedMutationContract, agent settings, room cards

## Price

`suggestChatPrice` from project budget / pricing rules. Shown on card as internal suggestion; **not** forced into message unless `full_auto` (or owner includes it).

## Safety

- Owner-only Telegram
- No secret leaks / no Playwright
- Emergency stop, blacklist, daily caps
- `ALLOW_LIVE_AUTO_SEND` (default false) required for live auto reply
- Mutations always through VerifiedMutationContract

## Modules

- `src/telegram/agent-settings.js` — `chatAiMode` / `CHAT_AI_MODES`
- `src/agent/room-state.js` — thread + answered index
- `src/agent/chat-continuum.js` — mode pipeline
- `src/agent/chat-price.js` — price suggestion
- `src/agent/messages-poll.js` — poll → continuum
- `src/telegram/room-card.js` — pick keyboard
- `docs/TELEGRAM_CHAT_AI.md` — this file
