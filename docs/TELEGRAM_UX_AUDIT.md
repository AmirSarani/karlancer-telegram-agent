# Telegram UX Audit — karlancer-telegram-agent

**Scope:** `src/telegram/**` only · Owner `@KarlanserAlertbot` (chat `1366010187`)  
**Baseline HEAD:** `c71ed46` / feature set `0a1dd9e`  
**Date:** 2026-09-22 (Asia/Tehran)

## Summary

The pre-redesign bot was a capable HITL control plane (status, approvals, scan, pause, chats, unread, notes, AI) but felt like an ops CLI glued to Telegram: flat 7–8 menu buttons, list spam (one message per room), no send confirmation, raw-ish errors, and a status dump instead of a SaaS health dashboard.

## Findings

### Critical

| ID | Issue | Impact | Fix in redesign |
|----|--------|--------|-----------------|
| C1 | Main reply keyboard had **7 items** (وضعیت، تأییدها، چت‌ها، خوانده‌نشده، اسکن، مکث/ادامه، راهنما) — exceeds 5–6 IA budget | Cognitive overload; hard to scan on mobile | Collapsed to **6**: داشبورد / گفتگوها / هشدارها / تأییدها / تنظیمات / راهنما; scan+pause under تنظیمات |
| C2 | **Approve send** created/decided the job **immediately** with no preview | Accidental mutation risk; owner cannot re-read draft | Two-step: `room:ok` → preview + Confirm/Cancel (`room:cfm` / `room:ccl`) |
| C3 | Chat list sent **N follow-up messages** (“اتاق #id”) per list | Chat spam; hard to navigate back | Single paginated message + inline View buttons |

### High

| ID | Issue | Fix |
|----|--------|-----|
| H1 | Status was a bullet dump, not “System Healthy” | Sectioned dashboard: health header 🟢/🟡/🔴 + سیستم / صف / فعالیت |
| H2 | AI output was a raw summary blob | `formatAiAnalysisCard`: ریسک · نیت · اقدام پیشنهادی · دلیل |
| H3 | Errors could surface Axios / technical strings | `friendlyErrorText` + Retry keyboard; no raw Axios |
| H4 | Inconsistent Back / Home / Refresh | Nav row on status, lists, cards, settings, errors |
| H5 | setMyCommands lagged new product language | Persian commands aligned to dashboard IA |

### Medium

| ID | Issue | Fix |
|----|--------|-----|
| M1 | Room card CTAs not View / AI / Note / Approve / Back | Reordered keyboard + Confirm flow |
| M2 | No pagination on long chat lists | `page:chats:N` / `page:unrd:N`, page size 5 |
| M3 | Sparse loading / complete copy | `formatLoading` / `formatComplete` |
| M4 | Empty states terse | Friendly FA empty copy for approvals / chats / unread |
| M5 | Preference for `editMessageText` incomplete | edit-first on callbacks for status, lists, cards, confirm |

### Low

| ID | Issue | Fix |
|----|--------|-----|
| L1 | Mixed legacy labels (چت‌ها vs گفتگوها) | Legacy `mapMenuText` aliases kept |
| L2 | Help listed slash commands before mental model of buttons | Help leads with menu, then advanced slash |
| L3 | Scan summary “HITL” jargon | Softer “هشدارها یا تأییدها” |

## Preserved capabilities

Owner guard · status · approvals · scan · pause/resume · chats · unread · notes · AI analyze · redaction · honest `blocked_by_missing_api` · no real send enablement beyond existing contract gate.

## Out of scope (unchanged)

Karlancer API adapters, MCP tools, DB schema, auth, worker business logic, Playwright, enabling live bid/message send without VerifiedMutation.
