# @examguard/realtime — WebSocket gateway (Phase 4 — NOT YET IMPLEMENTED)

**Status:** Designed. This directory is a contract placeholder, not a service. Do not claim it works.

The API already emits a typed event stream through `EventBus` (`services/api/src/common/event-bus.ts`), whose vocabulary is `packages/types` (`RealtimeEvent`, spec §34: `student.connected`, `student.camera.*`, `student.focus.*`, `student.paused/resumed/terminated/submitted`, `ai.alert`, `monitor.action`, `exam.timer`).

Phase 4 implementation plan:
1. WebSocket gateway (Socket.IO or `ws`) with JWT handshake auth, room model `exam-{examId}` and `attempt-{attemptId}`.
2. Subscribe to the API's outbox via Redis pub/sub (`@examguard/realtime` consumes; API publishes) so fan-out survives horizontally scaled API replicas.
3. Monitor consoles join exam rooms; student clients join their attempt room.
4. See `docs/ARCHITECTURE.md` §4.5 and `docs/API.md` → Realtime.