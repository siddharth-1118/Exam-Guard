# ExamGuard — Monitor Media Architecture

## Topology

```
                      ┌──────────────────────────────┐
                      │   ExamGuard API (:4000)      │
                      │  media subscriber token      │
                      │  (server-side authz + audit) │
                      └──────────────┬───────────────┘
                                     │ 200 { token(300s, role=subscriber), sfuUrl, ... }
                                     ▼
Student Desktop              ┌──────────────────────────────┐
(real camera/mic/screen ────►│  SFU  (mediasoup, :4010)     │
 device controller ─►        │  one room per participant    │
 publisher)                   │                              │
   send transport ──produce──►│  router ──consume──► recv    │
   camera/mic/screen          │              transport       │
                              └──────────────▲───────────────┘
                                             │ consumers
                              Monitor portal / E2E harness
                              (MonitorSubscriber — consumer only)
```

Media traverses the SFU exactly once per track. A publisher uploads each
camera/microphone/screen track as an independent producer
(`appData.kind ∈ {camera, microphone, screen}`); every authorized subscriber
creates its own consumers against those producers. There is no direct
student → monitor path and no client-side relaying.

## Room / identity model

- Room id = `MediaParticipant.id` (= participantId = media session id).
- One live publisher room per participant; the API refuses a second live
  gateway publisher (409) and the SFU evicts an overlapping publisher join
  server-side (never two rooms).
- A subscriber joins the **existing** room. If the publisher is reconnecting
  (room momentarily absent), the subscriber retries with fresh tokens
  (bounded); if the attempt ends, token issuance stops and the SFU closes the
  socket 4002 — no resubscribe into the void.
- Subscriber state is per-connection (`transports`, `transportStates`,
  `consumers` maps), so disconnects never cross-contaminate.

## Credential model

Two short-lived media tokens, both signed with the shared JWT secret
(`type: 'media'`, 300 s TTL), differing only in role and issuance path:

| | publisher | subscriber |
|---|---|---|
| Issued to | the attempt's own student | monitor / org admin / super admin |
| Endpoint | `POST /media/token` (owner of ACTIVE attempt) | `POST /media/subscriber-token` |
| Server checks | student owns the attempt; attempt ACTIVE | caller org matches attempt org; caller assigned to the exam; attempt watchable; participant derived server-side |
| Claims | sub/orgId/examId/attemptId/participantId + role | same + `role: 'subscriber'` |

The SFU re-verifies signature, expiry, `type='media'` and the role union on
every join, and derives all authorization from the verified claims — the
browser never supplies trustable identifiers.

## Consumer lifecycle

1. `join` (subscriber token) → SFU returns router RTP capabilities + the
   current `producers[]` list (id, kind, appKind).
2. `create-transport` (`direction: 'recv'`) → subscriber-only; the transport
   is recorded under this connection.
3. For each producer: `consume` with the client's RTP capabilities →
   `consumed` carries `consumerId`, kind, appKind, `rtpParameters`; the
   client-side mediasoup Device instantiates the consumer and hands the track
   to the UI.
4. `producer-added` push: a device that comes up mid-exam is consumed
   immediately without re-joining.
5. Teardown paths:
   - subscriber `leave`/socket close → `detachSubscriber`: closes that
     connection's consumers and recv transports; room and publisher untouched;
   - publisher leaves / attempt ends / admin eviction → `teardownRoom`:
     closes every subscriber socket **4002**, closes consumers/transports,
     destroys router (Phase 4D.1 server-side cleanup);
   - transport `closed`/`failed` → consumers die with it and notify via
     `consumer-closed`.

## Audio behavior

- Monitor audio is **muted by default** — subscribers attach the microphone
  track to a muted element. One monitor watching many students never hears a
  wall of live microphones.
- The monitor explicitly enables audio only for the focused student
  (a single *Enable audio* control in the live panel). Re-enabling happens per
  fresh track attach; switching students starts muted again.

## E2E verification (summary)

`scripts/media-monitor-e2e.mjs` proves the full path with real hardware:
student publisher (real camera/mic/screen → SFU) + real `MonitorSubscriber`
module in Chromium; decoded camera/screen frames via
`requestVideoFrameCallback`, live mic track, muted-by-default → enabled audio,
SFU-side consumer byte growth, clean disconnect ×2, attempt-end cleanup, and
the cross-org / wrong-participant / expired-token / no-room / ended-attempt
negatives. See `PHASE_4C_STATUS.md` for the measured numbers.

## Scaling note

Single-node SFU with in-process rooms and per-connection subscriber state.
Distributed presence (Redis), multi-node fan-out, and 10+/100+ student load
are explicitly out of scope of the phases that produced this architecture.
