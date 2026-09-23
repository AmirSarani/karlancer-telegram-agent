# 📚 کتاب فرصت‌ها

Telegram-navigable archive of opportunity scans — so quiet summaries (`جدید ۰ · منطبق ۰`) are not lost across chat history.

## Entry paths (`/start`)

1. **خانه** → reply keyboard **🔥 فرصت‌ها** → **📚 کتاب فرصت‌ها**
2. **🖥 کنترل سیستم** → **🧠 مغز** → **📚 کتاب فرصت‌ها**
3. After **نتیجه اسکن فرصت‌ها** → inline **📚 کتاب فرصت‌ها**
4. **⚙️ تنظیمات** → **📚 کتاب فرصت‌ها**

Callback root: `book:home` (does **not** re-notify).

## Sections

| Button | Contents |
|--------|----------|
| 🆕 جدیدها | `firstSeen` within ~72h |
| ⭐ امتیاز بالا | score ≥ threshold (default **55**, KV `opportunity_book_high_score`) |
| 📝 پیش‌نویس‌ها | stored bid/reply drafts (`pending`) |
| ✅ اقدامات | chronological log (notify, draft, approvals, skip, …) |
| 🔍 تاریخچه اسکن | past scan runs + per-run opp list |
| 📋 همه | paginated stored opportunities |

Detail cards reuse the readable notify format and the same HITL controls (پیش‌نویس، بفرست تأییدها، رد، جزئیات) when still valid.

## What gets stored (SQLite)

Extended in `src/opportunity/store.js`:

- **opportunity_projects** — snapshot (+ `last_scan_at`); idempotent on project id
- **opportunity_scan_runs** — every scan including quiet / skipped / cooldown
- **opportunity_actions** — notify, draft_prepared, sent_to_approvals, skipped, ignored, …
- **opportunity_drafts** — body, suggested price/days, status (`pending` / `approved` / `rejected` / `stale`)

Scanner (`src/opportunity/scanner.js`) **always** calls `recordScanRun` after a scan (and on skip paths). Opening the book never triggers Telegram re-notify.

## Retention

`pruneBook()` after each archived scan: ~90 days and caps (~500 opps, ~120 scan runs, ~1000 actions). Stale pending drafts aged out.

## Constraints

- Persian UX; no API jargon in Telegram copy
- HITL / VerifiedMutationContract unchanged
- Live auto flags remain off unless explicitly enabled on VPS
