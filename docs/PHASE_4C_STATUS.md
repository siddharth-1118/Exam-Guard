# ExamGuard — Phase 4C Status: Monitor Live-Media Subscriber + Live View UI

Phase 4C (subscriber core + monitor live-view UI) is implemented and
E2E-verified against the real API/SFU/Postgres. It builds on the Phase 4B
publisher and the Phase 4D.1 server-side cleanup, which both remain green.

## What exists and is verified

```
Student Desktop (real)
  ├─ camera   ─┐
  ├─ microphone┤  publishers
  └─ screen    ─┘     │
                      ▼
                   SFU router          ← one room per MediaParticipant
                      │  consumers
                      ▼
             Monitor Subscriber (real media, decoded frames)
```

- **Subscriber authorization**: `POST /api/v1/media/subscriber-token`
  (server-side org/exam/attempt/participant checks; 300 s scoped token,
  `role: 'subscriber'`). See `PHASE_4C_1_STATUS.md` for the full authz chain
  and the security-negative matrix.
- **SFU consumer core**: subscriber join → recv transport → consumers per
  producer; per-connection accounting; `producer-added` / `consumer-closed`
  pushes; consumer byte metrics on `/status`.
- **Monitor media client**: `apps/monitor-web/src/lib/media/subscriber.ts`
  (`MonitorSubscriber`) — a framework-agnostic consumer-only module (never
  calls `getUserMedia`), shared by the React portal and the E2E harness.
- **Monitor UI**: `apps/monitor-web/src/components/live-media-panel.tsx`
  mounted on the existing student detail page
  (`apps/monitor-web/src/app/monitor/students/[studentId]/page.tsx`):
  camera + screen video tiles, microphone track, **audio muted by default**
  with an explicit *Enable audio* control for the focused student, live
  feed/consumer status, and clean teardown on unmount/switch.
- **Student switching / cleanup**: the panel stops the previous subscriber
  (consumers + transports closed server-side) before subscribing to the next
  student; the E2E proves no consumers accumulate across cycles.
- **Attempt end**: when a student submits or is terminated, the SFU closes the
  monitor's socket 4002 and refuses new tokens for the attempt — Phase 4D.1
  cleanup remains authoritative (no client-side reconnect fight).

## Monitor Web live view (Phase 4C.2) — real browser UI

`apps/monitor-web` (Next.js App Router, production build) now drives the live
media end-to-end from the browser:

- **Student selection**: the existing monitoring board
  (`/monitor/exams/[examId]`) lists assigned students (name, code, attempt
  status, camera/mic/screen connection dots); clicking a student opens the
  detail page, which starts the subscription.
- **Real media panel** (`live-media-panel.tsx`): camera + screen video tiles
  (actual SFU consumer tracks attached to `<video autoplay playsInline muted>`)
  and a microphone tile with an `<audio>` element — **muted by default**, with
  an explicit *Enable audio (focused student only)* toggle.
- **States**: connecting… / ● live / reconnecting… / disconnected / feed
  unavailable — no raw WebRTC errors; token/authorization refusals settle to a
  readable "live feed unavailable" instead of retrying forever. Reconnects are
  bounded (fixed retry ladder) and server-driven: an ended attempt refuses new
  tokens and closes the socket 4002 (Phase 4D.1 authority).
- **Switching**: selecting a different student stops the previous subscriber
  (consumers + transports close server-side) before subscribing to the new
  one; audio resets to muted on every student change.
- **Cleanup**: unmount/route change/logout stops the subscriber; no stale
  consumers or transports remain (SFU `/status` verified at 0 after
  disconnect).
- **Security**: the browser only ever sees per-fetch, short-lived subscriber
  credentials through the authenticated `/api/gate` proxy (httpOnly session
  cookies); no SFU server secrets reach the client; the API remains the sole
  authorization authority.

## Monitor Web browser E2E — `scripts/monitor-live-view-e2e.mjs`

The new E2E drives the REAL Monitor Web application in an Electron/Chromium
harness (`apps/monitor-web/e2e/ui-main.cjs`) against a live publisher (real
camera + microphone + screen) while the orchestrator samples the SFU:

```
login (real form) → assigned exams → monitoring board → select student A
  → real camera + screen frames decode in the panel
  → mic muted by default → Enable audio (focused student)
  → switch to student B (active attempt, no media session)
      → A's SFU consumers cleaned, B settles to "feed unavailable"
  → back to A → fresh subscription (no accumulation), audio muted again
  → terminate A from the real UI modal
      → SFU room drains, MediaParticipant row ENDED
```

Verified results (run 2026-09-04):

- `UI_A_LIVE {cameraFrames:true, screenFrames:true, micLive:true,
  mutedDefault:true, audioEnabled:true}` — actual decoded frames in the portal.
- SFU consumer sample: 3 consumers / 1 subscriber; bytes grew for camera
  (190 880 → 209 239) and screen (612 749 → 721 879) during the live view.
- Switch to B: `switch-b-a-cleaned` — 0 consumers / 0 subscribers for A.
- Back to A: exactly 3 consumers restored, camera bytes growing again
  (`a-resubscribed-no-leak`).
- UI terminate modal → `UI_TERMINATED`, SFU room drained, `participant-ended`
  (DB row ENDED), harness `UI_DONE` exit 0.
- Final line: `MONITOR_LIVE_VIEW_E2E PASS`.

See `MONITOR_LIVE_VIEW.md` for the full monitor flow, lifecycle, failure
states and security model.

## Real-media infrastructure E2E — `scripts/media-monitor-e2e.mjs`

Pipeline proven end-to-end against the live API (:4000) + SFU (:4010) +
Postgres (:5433): a real Electron student publisher (real camera, microphone,
whole-display screen capture → mediasoup, held open by a hold-file) while the
real `MonitorSubscriber` module runs inside a second Electron Chromium.

Verified (not object existence — actual decoded media and byte growth):

- Chromium `requestVideoFrameCallback` fired for **camera and screen**
  (`cameraFrames: true`, `screenFrames: true`) in both cycles.
- **Microphone consumer track** present and live.
- **Audio muted by default** (`audioMutedDefault: true`), then explicitly
  enabled (`audioEnabled: true`).
- **SFU consumer byte growth** between samples for camera and screen
  (cycle 1: camera 117 057 → 157 435 bytes, screen 586 530 → 795 532 bytes)
  proving RTP actually traversed the SFU to the monitor — no
  student→monitor shortcut exists.
- **Clean disconnect** after each cycle: room reports `consumers: 0`,
  `subscribers: 0`; producers intact (3).
- **Attempt-end cleanup**: hold released → publisher submits `SUBMITTED` →
  SFU zero rooms → `MediaParticipant` row `ENDED`.

Security negatives (all server-enforced, all expected-denials):

| Negative | Result |
|---|---|
| Cross-org monitor → org A attempt token | 404 |
| Wrong `participantId` on a valid attempt | 404 |
| Expired subscriber token at the SFU join | 401 |
| Subscriber join, no publisher room | 409 |
| Subscriber token after attempt end | 403 |

## Regression status (all run against the final code)

- API unit **16/16** · API e2e-specs **25/25** · Desktop unit **45/45**.
- Phase 4A signaling E2E **PASS** · Phase 4B publish E2E **PASS**
  (self-cleaning now: duplicate-publisher room drains, process exits).
- Phase 4C monitor E2E **PASS** · Phase 4D.1 cleanup E2E **PASS**.
- Typecheck + build clean: api, media, student-desktop (main + renderer),
  monitor-web (Next).

## Bugs fixed during this phase (incl. 4C.2 harness)

1. `services/media/src/token.ts`: `verifyMediaToken` hardcoded
   `role: 'publisher'` — subscriber tokens joined as publishers, evicting the
   real room. Fixed to preserve the verified role.
2. `services/media/src/sfu.ts`: stale publisher socket close tore down its
   successor's room (reconnect churn + monitor 4002 storms). Fixed with
   `room.ws === ws` guards on close/leave.
3. `apps/student-desktop/src/media/publisher.ts`: transient mediasoup
   transport `disconnected` now gets a 5 s grace window instead of an instant
   full reconnect.
4. `scripts/media-monitor-e2e.mjs`: root `.env` `DATABASE_URL` (port 5432)
   overrode the dev-DB (5433) in the final DB check — the script now ignores
   the `.env` value unless the caller set one explicitly.
5. `scripts/media-publish-e2e.mjs`: leaked duplicate-publisher socket kept the
   process (and its SFU room) alive after PASS — now closes + drains + exits.
6. E2E harness isolation: the monitor-web harness (`ui-main.cjs`) now sets its
   own per-run `userData` directory (`EXAMGUARD_E2E_USER_DATA`) — previously a
   shared `%APPDATA%` directory carried cookies between runs, which could
   redirect "login" into a stale board and masquerade as stray page
   navigations. The orchestrator gives the harness a dedicated temp dir
   (`UI_USER_DATA_DIR`) cleaned up per run.
7. Login hydration race: the harness submits the form via `requestSubmit` only
   after React hydration (detected by the submit spinner) and re-fills the
   email/password fields before every retry (a pre-hydration native submit
   reloads the page and wipes the form, which otherwise caused an empty-form
   "Invalid email or password").
8. Terminate step: the harness targets `[role=dialog]` scoped selectors for
   the reason textarea + confirm button (the previous selector
   `placeholder^=Reason` never matched — the real placeholder is
   `e.g. Confirmed unauthorized materials`), re-enters the student if the page
   unexpectedly moves while the modal is open, and captures the page's own
   clicks / navigations for diagnostics.

## Known limitations

- Monitor audio content is not intelligibility-measured (decoded and the
  enable/mute control verified, but not speech-comprehension tested).
- The browser E2E drives the portal in an Electron/Chromium harness (the
  repo's established browser-automation pattern); Playwright/WebDriver are not
  used.
- Single-node SFU presence; Redis/distributed presence and multi-student load
  remain explicitly out of scope for this phase.
- One environment note: `monitor-web` requires `next build` before the E2E
  (the harness loads the production server).
- No scalability claims.
