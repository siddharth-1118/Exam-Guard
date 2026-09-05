# ExamGuard — Phase 4C.1 Status: SFU Monitor Subscriber Core

> Backend/SFU subscriber foundation only. Monitor UI and the real-media monitor
> E2E are covered in `PHASE_4C_STATUS.md` / `MONITOR_MEDIA_ARCHITECTURE.md`.
> This phase added no Redis, load testing, AI, recording, or scalability work.

## What was built

The monitor subscriber path through the existing Phase 4B SFU:

```
Student Desktop publisher
   └── camera / microphone / screen producers ──► SFU router
                                                     └── consumers ──► authorized monitor subscriber
```

Media always traverses the SFU once (publisher → router → N consumers). There
is no student → monitor direct path.

### 1. Subscriber authorization (server-side, API)

`POST /api/v1/media/subscriber-token` (`MediaService.issueSubscriberToken`) —
an authenticated monitor/org-watcher requests a credential for a specific
attempt. The server, never the browser, resolves every identifier:

1. attempt is looked up **by the caller's own org** (`organizationId: user.orgId`) — cross-org attempts 404;
2. the caller must be an org admin / super admin **or a monitor assigned to the exam** (`assertExamWatchAccess` → `ExamMonitorAssignment` row) — unassigned monitors get 403;
3. the attempt must still be watchable (not `SUBMITTED / AUTO_SUBMITTED / TERMINATED / UNDER_REVIEW`) — ended attempts get 403;
4. the media session row is derived from the attempt itself (`MediaParticipant` by `attemptId`); a client-supplied `participantId` must match that row or the request 404s (wrong-participant probing is indistinguishable from a missing resource);
5. a short-lived token is signed with the shared JWT secret.

Token scope (5-minute TTL, `type: 'media'`, `role: 'subscriber'`):

```json
{ "sub": "<participantId>", "orgId": "...", "examId": "...",
  "attemptId": "...", "participantId": "<same row id>",
  "role": "subscriber", "type": "media", "iat": ..., "exp": ... }
```

Response mirrors the publisher-token DTO: `token`, `sfuUrl`,
`mediaSessionId` (= participantId), `participantId`, `attemptId`,
`expiresInSeconds`. Issuance is audited (`media.token.issued-subscriber`).

### 2. SFU consumer support

The SFU keeps **one room per MediaParticipant** (`roomId == participantId`).
`services/media/src/sfu.ts` now accepts two roles:

- **publisher** (unchanged Phase 4B behavior): owns the room, creates the send
  transport, produces camera/microphone/screen tracks (`appData.kind`).
- **subscriber** (new): joins only an **existing** publisher room (never
  creates one, never subscribes into the void — 409 when no room), opens a
  **recv** transport owned by its own connection, and creates **consumers** for
  the producers the SFU advertises at join (`joined.producers[]`).

Signaling added for the consumer path:

```
→ { type:'create-transport', data:{ direction:'recv' } }   ← transport-created
→ { type:'consume', data:{ transportId, producerId, rtpCapabilities } }
← { type:'consumed', data:{ consumerId, producerId, kind, appKind, rtpParameters } }
← { type:'producer-added', ... }        (push — device came up mid-exam)
← { type:'consumer-closed', ... }       (push — producer/transport closed)
→ { type:'resume-consumer' | 'close-consumer' | 'close-transport' | 'leave' }
```

Consumer accounting lives **per subscriber connection** (`SubscriberConn`:
transports, transport states, consumers), so one monitor's disconnect can never
touch another's or the publisher's resources. Room-level `/status` exposes
producer **and** consumer byte counters (bitrate sampled from cumulative
bytes) for the monitor E2E's server-side growth proof.

### 3. Lifecycle

```
CONNECT → join(token, role=subscriber) → recv transport → consume(kind per producer)
        → ACTIVE/subscribed → DISCONNECT → detach (consumers+transport closed)
```

- Subscriber disconnect (`leave` or socket close): `detachSubscriber` removes
  the connection's consumers/transports; the publisher's room keeps running.
- Publisher leaves / attempt ends: `teardownRoom` closes every attached
  subscriber socket with **4002** and destroys the room — the Phase 4D.1
  server-side cleanup stays authoritative; a subscriber can never resubscribe
  into an ended attempt because the API refuses new tokens for it.

### 4. Cleanup guarantees (verified)

- Monitor disconnect leaves `consumers: 0`, `subscribers: 0` on the room.
- Attempt submit/terminate while a subscriber is attached closes the
  subscriber socket 4002 and drains the room (Phase 4D.1 cleanup E2E still
  green after this phase).
- No orphaned subscriber transports/consumers after repeated subscribe →
  disconnect cycles (two full cycles in the 4C E2E, plus reconnect-churn
  hardening below).

## Bugs found and fixed during this phase

1. **`services/media/src/token.ts` — subscriber role silently became publisher.**
   `verifyMediaToken` validated the role union but returned a hardcoded
   `role: 'publisher'`. Every subscriber join was therefore a *publisher* join:
   it evicted the real student's room, recreated it, and then got
   `400 publishers use direction send` when it asked for a `recv` transport.
   Phase 4B never noticed (publisher-only world); 4C is the first consumer of
   the role claim. Fix: preserve the verified role.
2. **`services/media/src/sfu.ts` — stale publisher close tore down its
   successor's room.** When a publisher reconnects, the new join evicts the old
   room; the old socket's async close event then ran
   `teardownRoom(participantId)` unconditionally and killed the *new* room,
   leaving the new socket orphaned (`409 room gone` on produce → reconnect
   churn → monitors kicked with 4002 in a loop). Fix: the close/leave handlers
   only tear down when the closing socket is still the room's owner
   (`room.ws === ws`).
3. **`apps/student-desktop/src/media/publisher.ts` — transient transport
   `disconnected` caused a full reconnect cascade.** Under load a mediasoup
   transport can blip `disconnected` and recover; the publisher treated it as
   fatal. Fix: 5 s grace window before escalating to reconnect; only `failed`
   or an actual socket loss reconnects immediately.

## Security tests (all against the live API + SFU, real tokens)

| Test | Result |
|---|---|
| Authorized monitor obtains subscriber token (assigned to exam) | 201 |
| Cross-org monitor (org B → org A attempt) | 404 denied |
| Wrong participantId supplied with a valid attempt | 404 denied |
| Expired subscriber token joined at the SFU | 401 denied |
| Subscriber join with no publisher room | 409 denied |
| Subscriber token after attempt end | 403 denied |

## E2E results (this phase's acceptance, real media)

`scripts/media-monitor-e2e.mjs` — real Electron student publisher (camera +
microphone + whole-display screen → mediasoup) held open while a real monitor
subscriber (the actual `MonitorSubscriber` module running in a second Electron
Chromium) consumed the three tracks through the SFU:

- SFU consumers created for camera / microphone / screen (`appKind` resolved).
- Server-side consumer byte growth between samples for camera and screen;
  microphone consumer present.
- Two full subscribe → verified → clean-disconnect cycles; after each, room
  `consumers: 0`, `subscribers: 0`, producers intact (3).
- Publisher submit → Phase 4D.1 eviction → SFU zero rooms, `MediaParticipant`
  row `ENDED`.

## Regression

- API unit 16/16 · API e2e-specs 25/25 · Desktop unit 45/45.
- Typecheck + build clean: `services/api`, `services/media`,
  `apps/student-desktop` (main + renderer), `apps/monitor-web` (Next build).
- Phase 4A E2E PASS · Phase 4B E2E PASS · Phase 4C monitor E2E PASS ·
  Phase 4D.1 cleanup E2E PASS.
- E2E script hygiene fix: `scripts/media-publish-e2e.mjs` duplicate-publisher
  leg left its socket open, so the script never exited and its `dup-participant`
  room leaked on the SFU (broke the cleanup E2E's zero-rooms baseline). It now
  closes its sockets, waits for the room to drain, and force-exits.

## Limitations

- Single-node SFU in-process state; no Redis/distributed presence (deferred).
- Subscriber authorization is enforced at token issuance + SFU join; tokens
  are bearer credentials valid 5 minutes (standard for this architecture).
- Monitor media reception in a real browser portal session is exercised
  through the E2E harness; no browser-automation suite drives the portal UI
  itself.
- No scalability claims were made or measured.
