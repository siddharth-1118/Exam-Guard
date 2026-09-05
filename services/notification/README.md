# @examguard/notification (Phase 7 — NOT YET IMPLEMENTED)

**Status:** Designed. Placeholder contract.

Queue worker (Redis + BullMQ) for email/push delivery: password-reset links (dev currently logs the token — see `services/api/src/auth`), exam scheduling reminders, monitor alerts. Wire `SMTP_URL` from `.env.example`.