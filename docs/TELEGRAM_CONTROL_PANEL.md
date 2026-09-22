# Telegram Control Panel

Owner-only remote control for Eyes / Brain / Hands — daily ops without Cursor/MCP chat.

## Entry

- Reply keyboard: **🖥 کنترل سیستم**
- Slash: `/control`
- Inline: home → کنترل سیستم · settings → کنترل سیستم

## Menu map

| Section | What |
|---------|------|
| 🖥 سیستم | Health, mode, live-auto flag, Bale status, MCP host/port (no secrets), contract count, owner ids |
| 👁 خواندن داده | Dashboard, profile (sanitized), chats, notifications, bookmarks, plans, project search wizard, SEO meta (path hint only) |
| 🧠 مغز | Opportunities hub, scoring profile, rules, opportunity scan, decision history, decision inbox |
| 🖐 عملیات | Approvals, mode, toggles, **ALLOW_LIVE_AUTO_BID** (confirm + warning), daily limits, blacklist, emergency stop |
| 🔐 امنیت | Session health, token age, renew (browser token preferred), owner ids |
| 🔔 اعلان‌ها | Morning digest send-now, multi-owner note, Bale configured/not + set token (deleteMessage, never echo) |
| 📜 تاریخچه | Last N audit / permission_gate / decision cards (Persian) |
| 🏆 پس از برد | Plan2 lite |
| ❓ نقشه | Non-technical map |

## Live auto bid

- Default **false** (env + KV).
- Toggle writes KV + `.env` `ALLOW_LIVE_AUTO_BID` + in-process hot reload.
- Emergency stop still wins. VerifiedMutationContract never bypassed.

## Constraints

- Owner-only; never print tokens/passwords/Authorization.
- Thin façades over adapters / opportunity store / settings — no duplicated business logic.
- Max 2 buttons/row; progressive disclosure.
- Telegram Bot API is **not** true E2E — documented in help.
