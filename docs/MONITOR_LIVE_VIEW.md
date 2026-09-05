# ExamGuard — Monitor Live View

How the Monitor Web portal displays the real-time media of a focused student.
Phase 4C.2: the browser consumes the student's camera / screen / microphone
through the SFU as a subscriber — it never captures anything itself.

## Flow

```
Monitor login (Next /api/auth/login → httpOnly session cookies)
      ↓
Assigned exams list  (GET /api/v1/monitoring/exams)
      ↓
Monitoring board     (GET /api/v1/monitoring/exams/:examId/students)
      — students assigned to the exam: name, student code, attempt status,
        camera/mic/screen connection dots, risk level
      ↓  click a student
Student detail       (GET /api/v1/monitoring/students/:studentId)
      ↓  mounts <LiveMediaPanel attemptId attemptStatus>
Request subscriber credential  (POST /api/v1/media/subscriber-token via /api/gate)
      ↓  short-lived scoped token (300 s, role=subscriber)
Connect to SFU (ws://…/sockets, token in join) → recv transport → consumers
      ↓
Camera video tile + Screen video tile (consumer tracks) + microphone <audio>
      — audio MUTED by default; [Enable audio] for the focused student only
```

Every browser↔API call goes through the Next `/api/gate` proxy with httpOnly
session cookies; the browser only ever holds a short-lived media token in
memory for the active subscription. No SFU server secrets exist in the client.

## Media connection

The panel uses the framework-agnostic `MonitorSubscriber`
(`apps/monitor-web/src/lib/media/subscriber.ts`, consumer-only — never
`getUserMedia`):

1. `getToken()` — per-(re)connect REST call; tokens are never cached.
2. `join` the SFU room for the participant (room = the student's live
   media-session; one per `MediaParticipant`).
3. `create-transport` (direction `recv`) + `connect-transport` (DTLS).
4. `consume` every producer the SFU advertises (`camera`, `microphone`,
   `screen` produced by the student's secure desktop in Phase 3B/3C).
5. Tracks are attached to `<video data-kind=camera|screen>` and
   `<audio data-kind=microphone>` via `srcObject`.

Transient publisher reconnects replace the room; the SFU pushes
`producer-added`/`consumer-closed`, and the module re-subscribes with a fresh
token on a fixed, bounded retry ladder. It stops permanently only when token
issuance is refused (attempt ended / authorization revoked / budget
exhausted) — the server stays authoritative.

## Camera / Screen / Microphone

- **Camera** and **screen** are separate `<video>` tiles, `autoplay playsInline
  muted` (video elements carry no audio). The panel re-attaches tracks when a
  publisher reconnect creates new track identities.
- **Microphone** is an `<audio>` element: `muted={true}` by default. The
  monitor can enable it with the *Enable audio (focused student only)* button;
  switching students or re-entering the student resets audio to muted. There
  is no multi-student audio (preventing 10+ simultaneous microphones).

## Student switching

Selecting student B while subscribed to A:

- React effect cleanup stops subscriber A (`stop()` → `leave` + close
  consumers/recv transport + socket) — verified server-side
  (`consumers: 0, subscribers: 0` on the SFU room).
- Then a fresh `MonitorSubscriber` starts for B.

The E2E proves the transition: A live → switch B (A's consumers cleaned) →
back to A (exactly 3 consumers restored, no accumulation).

## Attempt end

When the student submits, is terminated, or the attempt is otherwise over:

- The API refuses new subscriber tokens (403);
- the SFU closes the monitor's socket (4002) and tears down the room
  (Phase 4D.1 cleanup is authoritative);
- the panel shows a settled state ("the student session ended" /
  "live feed unavailable") and stops — no reconnect fight.

## Failure states (UI)

| Condition | Panel shows |
|---|---|
| starting | `connecting…` |
| live feed received | `● live` |
| transient socket/room drop | `reconnecting…` (bounded) |
| token/authorization refusal, attempt ended, student offline, no media session | `disconnected` + `live feed unavailable for this student` / session-ended message |
| SFU unreachable / retries exhausted | `failed` |

Raw WebRTC errors are never surfaced; connection details go to the dev console
only (and `NODE_ENV !== 'production'`).

## Cleanup

- **Student switch**: previous subscriber stopped (consumers, recv transport,
  socket) before the next starts.
- **Unmount / route change / logout / page close**: React effect cleanup calls
  `sub.stop()` — `leave` message + teardown; no stale consumers/transports.
- **Monitor disconnect**: SFU removes the subscriber connection; the SFU
  `/status` report returns to baseline (0 rooms/producers/consumers).

## Security model

- Authorization is server-side at token issuance:
  monitor → organization, exam → organization, attempt → exam, participant →
  attempt, attempt active, monitor authorized for the exam. Client-supplied
  ids are never trusted.
- Credentials are short-lived (300 s), scoped to one attempt/participant,
  `role=subscriber`, and never stored long-term (not persisted to localStorage).
- Cross-org / wrong-participant / ended-attempt / expired-token are rejected
  by the server (see the negative matrix in `PHASE_4C_STATUS.md`).

## Browser E2E result

`scripts/monitor-live-view-e2e.mjs` drives the real production Next portal in
an Electron/Chromium harness against a live publisher:

- Real login form → exams list → board → student A detail.
- Camera + screen frames actually decoded in the tiles
  (`cameraFrames: true, screenFrames: true`), microphone live
  (`micLive: true`), audio muted by default (`mutedDefault: true`), then
  enabled (`audioEnabled: true`).
- SFU consumer bytes grew during the view (camera 190 880 → 209 239,
  screen 612 749 → 721 879) — media genuinely traversed the SFU.
- Switch to B → A cleaned; back to A → exactly 3 consumers, no leak.
- UI terminate (real modal) → room drained, `MediaParticipant` row ENDED.

Full result: `MONITOR_LIVE_VIEW_E2E PASS`.