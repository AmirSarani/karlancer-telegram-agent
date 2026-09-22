# Telegram UX — Future ideas (not in this PR)

Kept out of scope intentionally.

1. **WebApp mini-dashboard** for denser tables (rooms, jobs) while Telegram stays HITL.
2. **Per-room mute / Snooze** with TTL in room-state.
3. **Inline draft edit** (force-reply or WebApp) instead of note-only adaptation.
4. **Unread badge on reply keyboard** (Telegram limitation — may need Menu Button WebApp).
5. **Multi-page approvals** in one edited message (today follow-ups after first).
6. **Push digest** (hourly unread summary) via notifyOwner scheduler.
7. **i18n toggle** (FA default / EN for support) — product is FA-first today.
8. **When VerifiedMutation for `messages.send` lands:** keep confirm preview; only flip honesty banner from blocked → live queue.
9. **Analytics:** anonymized tap counts for IA refinement (no message content).
10. **Deep-link** `t.me/Bot?start=room_<id>` for jump-to-card from external alerts.

Do not enable real bid/message send from Telegram until contracts + worker path are verified.
