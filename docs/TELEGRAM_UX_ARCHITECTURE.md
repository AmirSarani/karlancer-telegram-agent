# Telegram UX Architecture — AI Operations Dashboard

## Product framing

Telegram becomes an **owner-only SaaS ops dashboard** for Karlancer HITL — not a chatty bot.

Owner: `1366010187` · Bot: `@KarlanserAlertbot`

## Information architecture (max 6)

| Reply button | Action | Notes |
|--------------|--------|-------|
| داشبورد | System health card | Was «وضعیت» |
| گفتگوها | Paginated rooms | Was «چت‌ها» |
| هشدارها | Unread-only rooms | Was «خوانده‌نشده» |
| تأییدها | Pending approvals | Unchanged |
| تنظیمات | Pause/Resume + Scan | New hub |
| راهنما | Help | Unchanged role |

Slash commands remain as power-user shortcuts; `setMyCommands` mirrors the IA in Persian.

## Module map

| File | Responsibility |
|------|----------------|
| `src/telegram/bot.js` | Owner guard, command/hears/callback routing, status/settings/home |
| `src/telegram/ui.js` | Menus, nav keyboards, status/approvals/welcome/help/errors/loading |
| `src/telegram/room-card.js` | Room/list/AI/confirm formatters + short `callback_data` |
| `src/telegram/room-flows.js` | List/open/confirm-send/reject/note/AI flows |
| `src/telegram/notify.js` | One-shot owner notify (unchanged contract) |

## Callback vocabulary (≤64 bytes)

| Pattern | Meaning |
|---------|---------|
| `nav:home` `nav:dash` `nav:set` `nav:help` | Shell navigation |
| `refresh:status` `goto:chats` `goto:unread` `goto:approvals` | Deep links |
| `set:pause` `set:resume` `set:scan` | Settings actions |
| `page:chats:N` `page:unrd:N` | Pagination |
| `room:open\|ok\|no\|note\|ref\|ai\|cfm\|ccl:ID` | Per-chat |
| `ok:UUID` `no:UUID` | Queue approvals |

## Navigation principles

1. Prefer **`editMessageText`** on callback paths to reduce spam.
2. Every operational screen: **بازگشت / خانه / تازه‌سازی** where applicable.
3. Sensitive path: **Approve → Preview → Confirm** (Cancel returns to card).
4. Honesty: if `messages.send` VerifiedMutation missing → show `blocked_by_missing_api`.
5. Never put tokens/secrets in message text (`redactString` + friendly errors).

## Screen catalog

- **Home** — welcome + inline jump pad  
- **Dashboard** — 🟢/🟡/🔴 health + sections  
- **Conversations / Alerts** — paginated list + View  
- **Chat card** — AI · Note · Approve · Reject · Refresh · Back · Home  
- **Send confirm** — draft preview · Confirm · Cancel  
- **AI card** — risk · intent · action · reason  
- **Approvals** — per-item ✅/❌  
- **Settings** — pause/resume · scan  
- **Errors** — FA copy · Retry · Home  

## Changed files (implementation)

- `src/telegram/bot.js`
- `src/telegram/ui.js`
- `src/telegram/room-card.js`
- `src/telegram/room-flows.js`
- `tests/unit/telegram-ui.test.js`
- `tests/unit/telegram-notify.test.js`
- `tests/unit/telegram-nav.test.js` *(new)*
- `tests/unit/room-card.test.js`
- `docs/TELEGRAM_UX_*.md` *(this set)*

`notify.js` intentionally unchanged.
