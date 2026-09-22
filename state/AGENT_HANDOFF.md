# AGENT_HANDOFF (roadmap P1–P5 — 2026-09-22 Asia/Tehran)

- **repo:** https://github.com/AmirSarani/karlancer-telegram-agent
- **branch:** `api-first-mcp-agent` (see latest commit on push)
- **PR #1:** merge only if tests green + owner OK
- **VPS:** `77.221.156.164` → `/opt/karlancer-telegram-agent`

## What shipped (this roadmap)

### P1 Product
- Owner **scoring profile** in Telegram (مهارت / بودجه / دسته) → `scoringAvailable=true`
- **Rule editor** CRUD (create/edit/enable/disable/delete) — not only sample seed
- **🔥 فرصت‌ها** on main reply keyboard
- **Smart Bid** (human Persian + price/days) → HITL via PermissionGate
- **Limited AUTO_EXECUTE** (preview first N + daily limits; never unlimited)

### P2 Brain
- Invites path soft-fail alongside public search
- Client quality omitted honestly when API fields absent
- Light feedback learning (ignore/reject → kv bias)
- Lighter scan with `sinceLastId` / known-id skip; 30m scheduler

### P3 Security/Ops
- Token age / 401 **warning** (cannot rotate secrets for user)
- Daily backup script + cron installer + restore
- PR merge gated on green tests

### P4 UX
- **📥 صندوق تصمیم** unified inbox
- Morning digest ~09:00 Asia/Tehran (quiet if empty)

### P5 Docs
- `docs/EYES_BRAIN_HANDS.md` — Eyes/Brain/Hands; MCP vs Telegram; extension = knowledge bed

## Owner must still do manually

1. Rotate Karlancer password / bot token / root if ever pasted in chat — `scripts/rotate-secrets.md`
2. Capture HAR for live `bids.submit` / `messages.send` if still `blocked_by_missing_api`
3. Install backup cron on VPS: `bash scripts/install-daily-backup-cron.sh`
4. Configure scoring profile + rules in Telegram before enabling Auto + autoSubmitBids

## How to use new UIs

- Main keyboard: فرصت‌ها · صندوق · تأییدها · تنظیمات
- Settings → پروفایل امتیاز / قوانین فرصت
- Opportunity card → پیشنهاد هوشمند → درخواست تأیید ارسال
- `/opportunities` · `/inbox` · `/cancel` exits wizards
