# LIVE_SCAN

- timestamp_local: 2026-09-20 23:07 IRST
- source: GET `/api/rooms/?page=1` (live, auth OK)
- status: **ok**
- auth: true (VPS `main_boot`; live GET 200)
- total_rooms: **1016**
- per_page: **10**
- last_page: **102**
- page1_count: **10**
- page1_unread_flag_count: **1**
- page1_openish: **10**

## Schema notes

See `state/EXPERIENCE.md` section on live rooms API. Do not commit `LIVE_SCAN.json` (guest names / previews).

## Patterns on page 1 (no PII)

- Several last-message previews look like **already-submitted proposal** threads.
- At least one **invite-like** pattern — needs `messages-pg` + `check-bid` before any action.
- **1** room with unread on page 1 — prioritize for owner.

## Persian-ready owner bullets (HITL — no auto bid)

- مجموع حدود **۱۰۱۶** اتاق (۱۰۲ صفحه)؛ فقط صفحه ۱ نمونه‌برداری شد.
- در صفحه ۱: **۱** اتاق خوانده‌نشده — اول آن را باز کنید.
- چند رشته شبیه دعوت/پیشنهاد فعال‌اند؛ قبل از هر پیشنهاد: بررسی `check-bid` و تأیید دستی.
- برای اسکن توسط ورکر: در تلگرام `@KarlanserAlertbot` دستور `/scan` (فقط owner).
- ارسال پیشنهاد/چت هنوز **مسدود** است تا قرارداد HAR ثبت شود — فقط پیش‌نویس HITL.

## Next scan steps

1. Telegram `/scan` or MCP `project.list_invites`.
2. Deeper pages / unread filter; sample messages for invite `projectId`.
3. Draft proposal plans only; enqueue with `requires_approval`.
