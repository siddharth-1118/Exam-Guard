# ExamGuard — Phase 4A Status: Authenticated Media-Session Control Plane

> Phase 4A implements the authenticated media-session control plane only. No audio, video, screen media, WebRTC, SFU, recording, or AI is implemented.

Status: **COMPLETE and verified end-to-end against the real backend + PostgreSQL.**

## 1. What was implemented

An authenticated, tenant-isolated media-session control plane that will carry Phase 4B WebRTC/SFU signaling later:

- **MediaSession (participant) entity** — durable PostgreSQL row per (organization, exam, attempt, student, device session) with a **stable `participantId`** and an enforced state machine.
- **REST API** — create / get / end / monitor-discovery, all server-authorized.
- **Authenticated WebSocket gateway** — join/leave/state/reconnect/ping control messages on `ws://<api>/api/v1/media/ws`. Control-plane only: no SDP, no OFFER/ANSWER, no ICE, no RTP.
- **Reconnect semantics** — a reconnect restores the **same** `MediaSession` row and the **same** `participantId`; simultaneous live connections for one attempt are rejected (409).
- **Presence** — in-memory connection state, `lastSeenAt`, `connectedAt`; heartbeats are **not** written to PostgreSQL.
- **Tenant isolation + authorization** — every path resolves identity server-side from the verified JWT (never client-supplied IDs).
- **Proctoring-event integration** — meaningful lifecycle events (`MEDIA_SESSION_CREATED`, `MEDIA_CONNECTED`, `MEDIA_RECONNECTING`, `MEDIA_RECONNECTED`, `MEDIA_DISCONNECTED`, `MEDIA_FAILED`) travel through the existing desktop `ReliableOutbox` → `POST /api/v1/proctoring/events` with stable `clientEventId`s. No event per ping.
- **Audit trail** — `media.session.create / connected / reconnecting / disconnected / end` records via the existing `AuditLog` mechanism.
- **Desktop control link** — a `MediaLink` in the Electron main process starts with the ACTIVE attempt, joins the gateway, and tears down on submit/terminate/logout.

## 2. Architecture

```text
Student Desktop (Electron main)
      │  REST: POST /api/v1/media/sessions  (create, idempotent)
      │  WS:   /api/v1/media/ws            (authenticated control messages)
      ▼
API — MediaModule
      ├── MediaService        authorization, tenant isolation, DB state
      ├── MediaGateway        ws join/leave/state/reconnect/ping, presence, dup detection
      └── state.ts            pure transition table (unit-tested)
      │
      ▼
PostgreSQL — MediaParticipant (durable state)   │   in-memory presence (no per-ping writes)

Future (Phase 4B/4C — NOT implemented here):
MediaSession → SFU room → camera/mic/screen tracks → monitor subscribers
```

## 3. Files created/modified

**Created**

- `services/api/src/media/state.ts` — pure state machine + transition table
- `services/api/src/media/state.spec.ts` — state-machine unit tests
- `services/api/src/media/dto.ts` — request DTOs (attemptId, examId for discovery)
- `services/api/src/media/media.service.ts` — authorization + CRUD + discovery
- `services/api/src/media/media.controller.ts` — REST endpoints
- `services/api/src/media/media.gateway.ts` — authenticated WebSocket gateway
- `services/api/src/media/media.module.ts`
- `apps/student-desktop/electron/mediaLink.ts` — desktop control-plane link
- `scripts/media-signaling-e2e.mjs` — two-org E2E incl. security negatives

**Modified**

- `packages/database/prisma/schema.prisma` — `MediaParticipant` model + `MediaParticipantStatus` enum + `MEDIA_*` `ProctoringEventType` values (migration `20260904081300_phase4_media_participant`)
- `packages/types/src/index.ts` — `MEDIA_*` proctoring event types
- `packages/security/src/permissions.ts` — `media:publish`, `media:subscribe`
- `services/api/src/app.module.ts` — registers `MediaModule`
- `services/api/src/main.ts` — wires the media gateway to the HTTP server
- `services/api/src/monitoring/dto.ts` — accepts `MEDIA_*` event types (client whitelist twin)
- `services/api/src/monitoring/monitoring.service.ts` — monitor views expose participant state; attempts close participants on end
- `services/api/src/attempts/attempts.service.ts` — closes the open media participant on submit/terminate
- `apps/student-desktop/src/shared/types.ts`, `apps/student-desktop/src/shared/sensors.ts` — `MediaSessionInfo`, `MEDIA_*` sensor whitelist
- `apps/student-desktop/electron/api.ts` — media REST client + `mediaWsUrl`
- `apps/student-desktop/electron/session.ts` — MediaLink lifecycle wiring
- `apps/student-desktop/electron/main.ts` — E2E media-signaling leg

## 4. REST API

| Endpoint | Permission | Behavior |
|---|---|---|
| `POST /api/v1/media/sessions` `{ attemptId }` | `media:publish` | Create/reuse one session per active attempt (idempotent; returns the same row). Requires the attempt to belong to the caller, be in their org, and be on a live exam. |
| `GET /api/v1/media/sessions/:id` | `attempt:read` | Own session only; cross-student/cross-org lookups return 404. |
| `POST /api/v1/media/sessions/:id/end` | `media:publish` | Idempotent end; repeated calls are a no-op success. |
| `GET /api/v1/media/sessions?examId=` | `media:subscribe` | Monitor discovery: metadata only (studentId, attemptId, participantId, state, connectedAt, lastSeenAt), exam + org authorized. |

State returned: `CONNECTING`, `ACTIVE`, `RECONNECTING`, `DISCONNECTED`, `ENDED`, `FAILED`.

## 5. WebSocket protocol (`/api/v1/media/ws`)

Authentication happens **on the first message** (join carries the bearer token; nothing is trusted before verification).

```text
client → { type: 'media-session-join', data: { token, attemptId } }   // publisher
client → { type: 'exam-watch-join',   data: { token, examId } }      // monitor (subscriber)
client → { type: 'ping' } | { type: 'media-session-leave' }
server → { type: 'joined', data: { mediaSessionId, participantId, attemptId, state } }
server → { type: 'media-session-state', data: { participantId, state } }
server → { type: 'media-participant-connected' | 'media-participant-state', ... }  // monitors
server → { type: 'pong' } | { type: 'media-error', data: { code, message } }
```

Guards: 401 unauthenticated/expired; 403 wrong org/exam/attempt; **409 duplicate live connection** for an attempt; 429 rate limit (60 msgs/10 s, 500 conn cap); 400 malformed frames (never crashes the gateway).

## 6. State machine

```text
CONNECTING ──connected──▶ ACTIVE ──disconnected──▶ RECONNECTING ──connected──▶ ACTIVE
    │  │                    │  │                        │   (same participant)   │
    │  │                    │  └──ended/FAILED          └──expired──▶ DISCONNECTED
    │  └──ended/FAILED      └──failed                                          │
    └────────────────────────────────────────────── ended ────────▶ ENDED (terminal)
```

Invalid transitions are rejected server-side (`state.ts`, unit-tested). Reconnect/expired logic uses a 45 s grace window; the DB keeps exactly one row per attempt.

## 7. Reconnect behavior

`drop → RECONNECTING (bounded backoff) → rejoin with the SAME attemptId → ACTIVE`, same `mediaSessionId` and `participantId`. Verified by E2E: the reconnected participant equals the original. Duplicate-connection attempts while one is live are rejected with 409.

## 8. Authorization / tenant isolation

Identity chain resolved server-side on every path: JWT → user → role/permissions → organization → exam → attempt → device session → media session. Verified by E2E security checks:

- cross-student `GET` → 404
- cross-org session `POST` (org-B student on org-A exam attempt) → 404
- student `GET /api/v1/media/sessions?examId=` (monitor-only) → 403
- cross-org monitor discovery → 404

## 9. Desktop integration (Student Desktop)

`MediaLink` starts when an attempt becomes ACTIVE, creates/reuses the media session, opens one authenticated socket, joins, mirrors `connected/reconnecting/connected`, and ends on submit/terminate/logout (REST end is idempotent). No device acquisition, no `getUserMedia`/`desktopCapturer`, no media bytes — the Phase 3 device controller remains the sole owner of capture.

## 10. Tests

- API unit (`state.spec.ts`): valid/invalid transitions, reconnect identity, idempotent end — **8/8 pass**.
- Desktop suite (sensors, outbox, device controller, screen source, session): **45/45 pass**.
- E2E `scripts/media-signaling-e2e.mjs`: login → active attempt → create (idempotent) → WS join (CONNECTED) → duplicate join rejected (409) → drop → reconnect same participant → idempotent end (ENDED), plus 2-org security negatives → **PASS**.

## 11. E2E + database verification (real backend + PostgreSQL)

Latest run (attempt `25a17641…`): participant `ENDED`, tenant fields consistent across `MediaParticipant`, `ExamAttempt`, `Exam`, `Student`; `MEDIA_SESSION_CREATED`, `MEDIA_CONNECTED`, `MEDIA_DISCONNECTED` persisted with stable `clientEventId`s; **0 duplicate clientEventIds globally**; **0 orphaned ACTIVE/CONNECTING/RECONNECTING participants**; attempt `SUBMITTED`. Audit log shows `media.session.create/connected/reconnecting/disconnected/end`.

Note: post-drain transient events (`MEDIA_RECONNECTING` after the final drain, `MEDIA_DISCONNECTED` during submit teardown) are intentionally cleared with the attempt queue at submit — server row lifecycle is authoritative and was verified ENDED.

## 12. Security verification

- No WebRTC/SFU/RTP/SDP anywhere (grep-verified); the gateway rejects unknown message types.
- No permanent media credentials; nothing but the standard access token is used.
- Desktop: no `nodeIntegration`, no IPC exposure changes; `MediaLink` runs in the main process.
- Malformed frames return `media-error` without crashing; rate limits and a connection cap are enforced.

## 13. Regression results

- Phase 3A `scripts/desktop-e2e.mjs` — **PASS**
- Phase 3B/3C `scripts/desktop-media-e2e.mjs` — **PASS** (real camera `frames=true`, mic ok, screen `Entire screen` `screenFrames=true`)
- Desktop unit suite **45/45**, API unit **8/8**, typechecks (renderer + electron + API) clean, esbuild main/preload builds clean.

## 14. Known limitations

- A crashed client can leave a row in `CONNECTING`/`ACTIVE` until the attempt ends or an operator cleans it; a TTL sweeper is future hardening (one stale row from an interrupted debug run was cleaned manually during verification).
- `reconnects` counter on the participant row is not yet incremented by the gateway; reconnect evidence currently comes from events/audit.
- Presence is single-node in-memory (the API process); Redis-backed presence is future hardening when the API scales horizontally.
- No SFU/WebRTC, per scope.

## 15. Next phase (NOT started)

**Phase 4B** — WebRTC + SFU (mediasoup-style router) publishing/subscribing over this control plane: add `OFFER/ANSWER/ICE`, real transport sessions keyed by the stable `participantId`, short-lived media tokens, then monitor live subscription in Phase 4C.
