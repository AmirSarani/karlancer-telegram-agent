# Telegram UX — Before / After

## Menu

| Before | After |
|--------|-------|
| وضعیت · تأییدها · چت‌ها · خوانده‌نشده · اسکن · مکث/ادامه · راهنما (7) | داشبورد · گفتگوها · هشدارها · تأییدها · تنظیمات · راهنما (6) |
| Scan & pause at top level | Under **تنظیمات** |

## Status

| Before | After |
|--------|-------|
| Flat «وضعیت ایجنت» bullets | «داشبورد عملیات» + 🟢 سیستم سالم / 🟡 / 🔴 sections |

## Chats

| Before | After |
|--------|-------|
| Summary + N separate “اتاق #id” messages | One paginated card + inline View buttons |
| Open → card with Approve immediate | Open → card → Approve → **preview Confirm/Cancel** |

## AI

| Before | After |
|--------|-------|
| Raw summary dump | Card: ریسک · نیت · اقدام پیشنهادی · دلیل |

## Errors / loading

| Before | After |
|--------|-------|
| Occasional technical / Axios-ish text | Persian friendly + Retry |
| Sparse “در حال…” | Explicit loading → complete helpers |

## Example copy (FA)

**Dashboard header:** `🟢 سیستم سالم`  
**Empty unread:** `فعلاً خوانده‌نشده‌ای نیست — عالی است! 🎉`  
**Confirm:** `⚠️ تأیید نهایی ارسال` + honest `blocked_by_missing_api` when API contract missing.
