# Security notes / نکات امنیتی

## محدودیت صادقانهٔ تلگرام (فارسی)

ربات تلگرام (Bot API) **رمزنگاری سرتاسر (E2E) ندارد**. پیام‌هایی که به ربات می‌فرستید از مسیر HTTPS به سرور تلگرام می‌روند و **سرور تلگرام می‌تواند متن را بخواند**. این محدودیت پلتفرم است؛ ایجنت کارلنسر نمی‌تواند روی بدنهٔ پیام‌های Bot API «E2E واقعی» اضافه کند.

آنچه پیاده‌سازی شده:

- ارتباط ایجنت با کارلنسر و با `api.telegram.org` فقط روی **HTTPS**
- شمارهٔ موبایل در مرحلهٔ تمدید نشست فقط به‌صورت **رمزنگاری‌شده در حافظه** نگه داشته می‌شود
- تلاش برای `deleteMessage` روی پیام رمز/شماره
- فیلتر قوی لاگ برای Bearer / رمز / شماره
- توکن دسترسی در `.env` با مجوز `600` — نه در SQLite و نه در لاگ

اگر رمز کارلنسر را در چت ربات تایپ کردید، بعداً پیام را پاک کنید و در صورت نگرانی رمز را عوض کنید.

## English summary

See also `AUTH_FLOW.md` (transport table) and `SECURITY_MODEL.md` (trust boundaries).

| Control | Status |
|---------|--------|
| HTTPS-only Karlancer / OpenAI / Telegram API root | Enforced in config + `assertAllowedUrl` |
| Bot message E2E | **Not possible** on Bot API — documented, not claimed |
| Ephemeral phone AES-256-GCM | `TELEGRAM_SECRETS_KEY` / derived |
| Token at rest | `.env` mode 600; no SQLite token storage |
| HITL / VerifiedMutationContract | Unchanged |
