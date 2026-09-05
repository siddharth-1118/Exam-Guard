# Phase 3C — Screen Capture Integration: Status

**STATUS: IMPLEMENTED & VERIFIED (Windows, real hardware)**

> Phase 3C provides screen-capture acquisition and lifecycle monitoring. It does not stream, record, store, or AI-analyze screen content.

## Implementation

Real whole-display screen capture wired into the existing exam lifecycle and the verified
`ReliableOutbox → POST /api/v1/proctoring/events → PostgreSQL` pipeline. No WebRTC, no SFU, no
recording, no upload, no AI analysis, no OS lockdown.

### Source selection
- `src/shared/screenSource.ts` (new): pure, DOM-free source-selection logic. Prefers the primary
  display; never silently selects an unexpected display; supports multiple displays/sources with
  explicit ordering and a label of what is being captured.
- Renderer `desktopCapturer.getSources({ types: ['screen'] })` in the main process is the source
  of truth for available displays; the selected source name is surfaced in the UI and in events.

### Permission behavior
- `setDisplayMediaRequestHandler` in `electron/main.ts` now answers `display-capture` requests
  (only for the exam window) — previously hard-denied in Phase 3B.
- Grant → `SCREEN_PERMISSION_GRANTED`; OS/user denial → `SCREEN_PERMISSION_DENIED` (WARNING);
  no source available → honest FAILED session state, **no fake event**.

### Capture lifecycle
- `deviceController.ts` generalized to a `kind: 'camera' | 'mic' | 'screen'` controller; screen
  acquisition goes through the same state machine (CHECKING → ACTIVE, end-of-track → DISCONNECTED
  → bounded reacquire).
- `src/media/devices.ts` `acquireScreenSource(sourceId)` starts capture; the controller registers
  track-lifecycle listeners; unexpected track end updates local state, shows a warning in the exam
  UI, and emits `SCREEN_CAPTURE_STOPPED`.
- On start/stop the correct media session (`ScreenSession`) transitions ACTIVE → ENDED via the
  existing `POST /api/v1/proctoring/sessions` update.

### Display changes
- Existing `screen.on('display-*')` handling in the main process remains; display configuration
  changes push state and emit display-related events through the same pipeline.

### Events (existing vocabulary, all with stable `clientEventId`)
- `SCREEN_PERMISSION_GRANTED` (INFO)
- `SCREEN_CAPTURE_STARTED` (INFO)
- `SCREEN_CAPTURE_STOPPED` (INFO)
- `SCREEN_PERMISSION_DENIED` (WARNING)

### Cleanup
- Exam submit / terminate / unmount stops capture via the shared controller (`stop()` releases
  tracks, removes listeners). Verified: no active capture track after exam end; camera/mic
  cleanup from Phase 3B unaffected (all three sessions ENDED in the same attempt).

### UI
- Preflight now shows a real Screen row (Checking / Available / Denied / Unavailable). Screen is
  gated like camera/mic when the exam settings require it; optional when not.
- Exam runner header shows `Screen ●` status; a disconnect banner appears if required capture
  stops unexpectedly. No redesign — minimal additions only.

## Files changed
- `apps/student-desktop/src/shared/deviceController.ts` — generalized to camera | mic | screen kinds
- `apps/student-desktop/src/shared/screenSource.ts` — new pure screen-source picker
- `apps/student-desktop/src/shared/types.ts` — screen state/source contract, renderer-visible display-count
- `apps/student-desktop/src/media/devices.ts` — `acquireScreenSource`, display-change subscription, generalized handle
- `apps/student-desktop/electron/main.ts` — `display-capture` permission handler, display-change push, real screen probe leg, serialized media-session updates
- `apps/student-desktop/electron/preload.ts` — richer screen-source IPC + display-change subscription
- `apps/student-desktop/src/screens/PreflightScreen.tsx` — real screen check
- `apps/student-desktop/src/screens/ExamScreen.tsx` — screen chip, gating, disconnect notice
- `apps/student-desktop/test/deviceController.test.ts` — screen lifecycle cases added
- `apps/student-desktop/test/screenSource.test.ts` — new picker tests
- `scripts/desktop-media-e2e.mjs` — screen leg assertion
- `docs/PHASE_3C_STATUS.md` — this report

## Tests
- **45/45 pass** (6 suites): 8 camera/mic device-controller cases, screen lifecycle cases
  (available / no source / multiple sources / start / normal stop / unexpected track end /
  source disappears / cleanup on stop), screen-source picker cases, plus existing api / outbox /
  sensors / session suites. Camera/mic tests unchanged and still green.
- Commands: `tsc --noEmit` (renderer + electron configs), esbuild main/preload bundle, `vite build`.

## Real Windows E2E result — PASS
`node scripts/desktop-media-e2e.mjs` against the live API (`:4000`) and real Postgres:

```
E2E_MEDIA         {"camera":"ok","mic":"ok","cameraFrames":true}
E2E_MEDIA_SCREEN  {"screen":"ok","screenFrames":true,"sourceName":"Entire screen"}
E2E_STEP media events delivered
E2E_STEP submit SUBMITTED
DESKTOP_MEDIA_E2E PASS (real devices exercised)
```

Screen capture actually started (real `desktopCapturer` source → `getUserMedia` desktop stream)
and produced verifiable frames (canvas pixel check) before release. Plain desktop E2E
(`scripts/desktop-e2e.mjs`) still passes — no camera/mic regression.

## Database verification — PASS
Attempt `SUBMITTED`, `scoreGraded=true`, `score=1`. Eight `ProctoringEvent` rows, all with
`clientEventId`, **zero duplicate clientEventIds**:

```
EXAM_WINDOW_LOST_FOCUS   WARNING   (existing pipeline check)
CAMERA_PERMISSION_GRANTED INFO
CAMERA_CONNECTED          INFO
MIC_PERMISSION_GRANTED    INFO
MIC_CONNECTED             INFO
SCREEN_PERMISSION_GRANTED INFO
SCREEN_CAPTURE_STARTED    INFO
SCREEN_CAPTURE_STOPPED    INFO
```

`CameraSession`, `MicrophoneSession`, `ScreenSession` all `ENDED` (started + ended set). Outbox
reached 0 pending after server acknowledgement before submit.

## One fix during verification
The first media-E2E run showed `CameraSession` still `ACTIVE` after the run: fire-and-forget
media-session PATCHes (ACTIVE then ENDED) raced and the server applied them out of order.
Fixed by awaiting each media-session update in the probe (`electron/main.ts`) so lifecycle order
is enforced on the wire. Mic/screen had won the race that run; the fix makes all three
deterministic — confirmed ENDED on rerun.

## Known limitations
- Physical multi-display add/remove and "user stops sharing" OS affordances are not replayed live
  on hardware in this environment; covered by unit tests plus documented manual checklist.
- Capture is whole-display only (preferred primary), not per-application windows.
- Screen capture does **not** prevent use of another physical device and is not OS lockdown.
- Display-change → reacquire logic is implemented; platform (X11/Wayland) nuance documented in
  `docs/PLATFORM_SECURITY_MATRIX.md`.

## Next phase (not started)
Phase 4 — media transport: WebRTC + SFU + monitor live view (streaming the acquired camera/mic/
screen sources), recording/storage policy, and AI-assisted analysis on server side.
