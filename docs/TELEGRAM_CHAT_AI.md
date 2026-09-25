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

## Phase B — full-auto that actually works, safely (2026-09)

- **Default criterion (chosen over a mandatory wizard):** when `rules.messageAuto.enabled` is on and no
  criterion is set, the gate requires AI confidence ≥ `DEFAULT_MESSAGE_SCORE_THRESHOLD` (60). Chat score =
  analysis/draft confidence × 100, computed per reply; a missing score → `score_unavailable` (owner card).
  Keywords are matched against the **client's** text, not our draft.
- **Wizard:** «📜 قوانین» → «✏️ معیار پیام خودکار» (lines `کلیدواژه:` / `حداقل بودجه:` / `حداقل اطمینان:`,
  «پاک» clears) and «💸 سقف تخفیف و کف قیمت» (`تخفیف:` / `کف قیمت:`). Persian digits accepted
  (`src/telegram/rule-wizard.js`).
- **Daily auto limit** counts only `auto.*` audit rows in the **Tehran day** (`tehranDayBounds`). Owner
  confirmations are audited as `owner.<action>` and never count. Preview cards (`approvalPreviewFirstN`)
  are counted separately (`previews`) and only while live auto-send is allowed.
- **Answered only after POST success.** Continuum/owner confirm set decision `sending`
  (+ `thread.pendingSendJobId`); the worker (`messages.send`) calls `markAnswered` after a successful POST
  and emits `message.sent`; failures emit `message.blocked` (decision `blocked`). `index.js` turns both
  (and `bid.blocked`) into Persian owner notices on Telegram **and** Bale (`notifyAllOwnersChannels`).
- **Double-send guard:** if `thread.lastSentAt` is newer than the job's `createdAt`, the job goes to
  `needs_reconciliation` (`superseded_by_newer_send`) without a POST.
- **scan-prepare skips** (`scanSkipReason`): `sending`, `already_answered` (no newer inbound),
  `no_fresh_inbound` (unread 0 and not an invite), `already_carded` (continuum already made a card for
  the latest inbound). Pending-send check kept.
- **Token budget:** chat continuum and scan-prepare call `budget.decide({intent:'draft_chat_reply'})`;
  when `DAILY_TOKEN_LIMIT` is exhausted the LLM is skipped and full-auto routes to the owner
  (`token_budget_exceeded`).
- Room cards show «📤 در حال ارسال» and «چرا خودکار نفرستادم: …».

## Phase C — pricing (2026-09)

- **Unit:** every amount is **Toman** (Karlancer budgets are Toman). `recommendPrice` / LLM schema /
  deterministic ranges now say `TOMAN`; cards and prompts show «تومان».
- **Price decision** (`decideChatPrice` in `src/agent/chat-price.js`): owner's answer for this room →
  confident learned median (≥ 5 similar samples, IQR/median ≤ 0.35) → project budget (nudged toward the
  learned median when ≥ 3 samples) → learned median (uncertain) → pricing rules.
- **«چه قیمتی بدهم؟»** (full_auto): when the price matters (client asked price/discount, or first reply on
  a project) and the price is not the owner's answer / confidently learned, and there is no budget
  (includes first-time project types) or analysis confidence is low → room card with the suggestion,
  «بر اساس N قیمت قبلی» and buttons «✅ همین قیمت» (`room:pok`) / «✏️ مبلغ دیگر» (`room:pset`, owner
  replies e.g. «۲۸ میلیون»). The answer is stored (kv `room:<id>:price_answer`, 30 days) and a
  `chat.resume_price` job continues the auto path with that price (same safety checks, gate, mutation
  contract; live send still needs `ALLOW_LIVE_AUTO_SEND`).
- **Learning** (`src/agent/price-memory.js`, table `price_samples`): owner answers/approvals and prices
  actually sent (parsed from the sent text after POST success) with features (category, keyword tags,
  scope, days). Deduped per room + amount.
- Fix: the production worker now receives the PermissionGate (without it full-auto always fell back to HITL).

## Phase D — follow-through (2026-09)

- **Scheduled follow-up** (`followup_scan` → `followup.scan`, every 30 min, `src/agent/follow-up.js`):
  answered room (in the answered index), no client reply for `followUp.afterHours` (default 24h), not
  older than `maxAgeDays` (7), fewer than `maxPerRoom` (default 1, max 2) follow-ups, no pending send.
  One draft per unanswered message (`thread.followUpDraftedFor`), even if the owner rejects it.
  Draft: LLM (short, polite, no new price) within the token budget, otherwise a fixed polite template.
  Same path as any send (mutation requester → PermissionGate → approval / VerifiedMutationContract).
  HITL unless `chatAiMode=full_auto` + `mode=auto` + live auto-send allowed + LLM draft + gate allows.
  Owner notice «🔁 … پیام پیگیری آماده کردم» (Telegram + Bale) with «✅ تأییدها».
  Settings: «📜 قوانین» → «🔁 پیام پیگیری» (`وضعیت:` / `بعد از:` / `حداکثر:`).
- **Scheduled win detection** (`wins_scan` → `wins.scan`, every 10 min, `src/agent/win-watch.js`):
  notifications with win phrases + status of projects we bid on in the last 30 days (assigned
  freelancer == our user id; a few per run, rotating). Deduped in kv `postwin:seen`; the first run does
  not replay wins older than 24h. The first client message (post-win draft) is queued as a
  `messages.send` approval with `forceRequireApproval` (always HITL) and pushed to all owners on
  Telegram **and** Bale (`notifyAllOwnersChannels`). State persisted in `postwin:state:<key>` and
  `postwin:latest` (shown in «🏆 پس از برد»).
- Forced-approval requests (scan-prepare, follow-up, post-win) are audited as `gate.*`
  (`forced_approval`), so they never count toward the daily automatic limit.

## Item 1 — full text (2026-09)

- `src/telegram/split-text.js`: long text is split into sequential messages (≤ 3900 chars each,
  numbered «(۱ از ۳)»), preferring paragraph/line/sentence/word boundaries; never inside an HTML tag,
  entity or surrogate pair. Used by bot/room-flows `editOrReply`, `notifyOwner`, `editOwnerMessage` and
  Bale notify. Buttons are attached to the last part.
- «🔎 جزئیات فرصت» shows the complete description (HTML stripped); if the stored text looks shortened, the
  public project page is read (read-only) and the longer text is used.
- Room card no longer truncates at 3900; «👁 مشاهده» shows full message texts and the full project
  description. Chat cards keep the full project description (was 500 chars) + skills/category.
- «💰 چه قیمتی بدهم؟» card (`formatPriceAskCard`): title, full description, budget, category/skills,
  the client's requests from the chat (analysis summary/requirements or their last messages), scope,
  difficulty, days, suggested price, acceptable range and «چرا این قیمت».

## Item 2 — learning past manual prices (2026-09, READ-ONLY)

- `src/agent/price-crawl.js` `crawlPastPrices`: GET-only, polite delay (~0.7 s between calls).
  - Past bids: `GET /api/bids?page=N` (Laravel page of 10; `api.bids.listMine`). Amount = sum of
    milestone budgets (Toman), else `budget`; days = `duration`; nested project (title, description,
    budget, skills). `won` = status not in pending/declined/failed/canceled/rejected/withdrawn.
  - Chat prices: rooms list + first messages page per room; our messages (`sender_id` == own user id)
    parsed with `extractSentPrice` («۲ میلیون», «۱,۵۰۰,۰۰۰ تومان», «... ریال» ÷ 10, "3 million").
  - Stored in `price_samples` with `ext_id` (`bid:<id>` / `chat:<msgId>`, unique) → re-runs only
    refresh `won`. Features: category, keywords (skills), scope tier, difficulty, days, source, won, short title.
- Re-run: Telegram «📜 قوانین» → «🔄 یادگیری از قیمت‌های قبلی» (worker job `pricing.crawl`, owner gets a
  count summary), or on the server `node scripts/crawl-prices.mjs` (prints counts + anonymized samples).

## Item 3 — effort-based pricing (2026-09)

- `deriveJobTier` → small / medium / large (+ difficulty) from analysis complexity, requirement count,
  days, description length, size keywords and client budget.
- Per-job range: similar past samples p25..p75 (≥ 3 samples; samples two tiers apart are ignored) →
  client budget → `ruleRangeForTier` (small 0.8–5M, medium 5–25M, large 25–90M Toman). Without budget
  or history the suggestion is the tier's own mid (by days), not a flat big-project price.
- Discount cap is relative to the job's own price. The global price floor is optional (off by default)
  and only applies to jobs priced at or above it, so a ~1M Toman job is never rejected by it.
