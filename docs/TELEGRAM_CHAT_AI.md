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

## Scan → prepare → HITL

`rooms.scan` no longer stops at a priority list. After listing rooms that need review:

1. Cap top N (default 5, hard max 10)
2. Reuse Brain (`analyzeRoomWithLlm` + `adaptDraftWithNote` + `cleanHumanReply`) via `src/agent/scan-prepare.js`
3. Enqueue `messages.send` (and invite `bids.submit` when matched) with **`forceRequireApproval: true`**
4. Summary copy: «N مورد تحلیل شد → منتظر تأیید شما» + deep link to **تأییدها**
5. Never live auto-send/bid from scan (`ALLOW_LIVE_AUTO_*` still required elsewhere + gate)
6. Emergency stop skips prepare; «تحلیل همه» (`rooms.prepare_scan`) retries from last summary

Modules: `src/agent/scan-prepare.js`, `src/worker/handlers.js` (`rooms.scan` / `rooms.prepare_scan`), `src/telegram/scan-ux.js`


## Phase A — correct replies (2026-09)

- **Real conversation to the LLM.** `src/agent/conversation.js` builds a chronological, two-sided history
  (last 12 messages, each trimmed to 500 chars). `adaptDraftWithNote` always sends the client's latest
  turn (messages after our last reply) as `employer_message`, the history as `conversation`, and
  owner/system hints as a separate `internal_note`. A note is **added**, never a replacement.
- **Direct chats without a project** are analyzed from the client's messages (`analyzeRoomWithLlm`
  passes `clientMessages` + `conversation`; provider prompt says so).
- `analysis.estimated_days` / requirements go into the draft context; analysis confidence (min with the
  draft confidence) is used for auto-send safety (`autoMinConfidence`, default `0.6`).
- **Fallback is never auto-sent.** Provider fallbacks are flagged `fallback:true`; `adaptDraftWithNote`
  returns `llmUsed:false, fallback:true`; `autoSafetyCheck` routes to an owner card
  (`llm_fallback`, `analysis_unavailable`, `low_confidence`, `discount_over_limit`, `below_price_floor`, `no_client_text`).
- **Own-message detection:** `normalizeInboundMessage` keeps `sender_id`; `getOwnUserId` resolves our
  Karlancer user id via `api.user.me()` (cached 24h in kv `karlancer_own_user_id`); `markOwnMessages`
  fills `isOwn` when `is_me` flags are missing. The client's id is sent as `receptorId`.
- **Negotiation:** `detectNegotiation` (discount %, portfolio, price, time; Persian digits OK) +
  settings `pricing.maxDiscountPct` (default 10) and `pricing.priceFloorToman`. A request above the limit or
  below the floor goes to the owner. `REPLY_SYSTEM` includes `NEGOTIATION_RULES` (portfolio: point to the
  Karlancer profile, no outside links).
