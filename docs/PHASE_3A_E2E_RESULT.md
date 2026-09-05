# Phase 3A — Desktop End-to-End Verification Result

Date: 2026-09-04 · Runner: `scripts/desktop-e2e.mjs` · API: `http://localhost:4000` · DB: dev Postgres `:5433/examguard`

## PHASE 3A E2E VERIFIED

```
STATUS: PASS

API:
PASS — GET /health and GET /ready returned ok; database check up. Fixture
      (org → admin → student → OPEN exam → MCQ question → assignment) created
      through real REST endpoints with no mocks.

DESKTOP:
PASS — Real Electron 44 app (dist/main/main.js) launched via its real binary
      from scripts/desktop-e2e.mjs and exited 0 on completion; no orphaned
      processes remained.

LOGIN:
PASS — E2E_STEP login student-mtmn0ypr@examguard.test role=STUDENT
      (POST /api/v1/auth/login through the app's ApiClient in the main process).

EXAM LIST:
PASS — E2E_STEP exams 1 (GET /api/v1/exams returned the assigned OPEN exam).

ATTEMPT:
PASS — E2E_STEP start ACTIVE remainingMs=1799986 questions=1
      (POST /api/v1/attempts; server-authoritative timer received;
      DB row created).

ANSWER:
PASS — E2E_STEP answer saved. Answer queued in the desktop's persisted outbox
      and acknowledged by POST /api/v1/attempts/:id/answers; outbox drained to
      0 before submit. DB: 1 answer row (question 60ba…, option 30ae…).

HEARTBEAT:
PASS — E2E_STEP heartbeat ACTIVE (POST /api/v1/attempts/:id/heartbeat).
      DB: DeviceSession updated — status ACTIVE, lastSignalAt=13:03:52Z,
      os=win32, appVersion=0.3.0.

PROCTORING EVENT:
PASS — E2E_STEP proctoring event delivered. EXAM_WINDOW_LOST_FOCUS / WARNING
      sent through the real session → ReliableOutbox → POST /api/v1/proctoring/events
      with a stable clientEventId (0866c2bf-…); outbox drained to 0.
      DB: 1 ProctoringEvent row with clientEventId populated.

SUBMISSION:
PASS — E2E_STEP submit SUBMITTED (POST /api/v1/attempts/:id/submit);
      student logged out afterwards; E2E_OK printed; electron exited 0.

DATABASE VERIFICATION:
PASS — Prisma query against the real database for student
      student-mtmn0ypr@examguard.test:
        ExamAttempt:  status=SUBMITTED, startedAt 13:03:50 → submittedAt
                      13:03:53Z, scoreGraded=true, score=1, answers=1
        ProctoringEvent: EXAM_WINDOW_LOST_FOCUS WARNING, clientEventId set
        DeviceSession: ACTIVE, lastSignalAt updated by heartbeat
        AuditLog:      attempt.start | attempt.submit

FAILURE ROOT CAUSE:
The earlier "hang" was not a code deadlock: the E2E hook in
apps/student-desktop/electron/main.ts had been added AFTER the last
`dist/main/main.js` build, so Electron launched a stale bundle that contained
no E2E logic and simply stayed open on the login screen forever. The previous
scripts/desktop-e2e.mjs also buffered all output until exit (nothing visible
during a stall) and had no timeout, so the runaway process was only discovered
as orphaned electron.exe processes.

FIXES:
1. Rebuilt the desktop main bundle (esbuild electron/main.ts → dist/main/main.js)
   so the running app actually contains the E2E flow. (Root-cause fix.)
2. scripts/desktop-e2e.mjs: stream app stdout/stderr live with [app]/[app-err]
   prefixes and enforce a 120s watchdog that kills the app and dumps captured
   output instead of hanging silently.
3. electron/main.ts (E2E mode only): per-step progress tracking plus a 60s
   fail-safe that prints `E2E_FAIL: flow stalled at step: X` and exits 2, so a
   stall can never again leave an orphaned GUI process.
4. The E2E flow was missing a proctoring-event step entirely (first DB check
   showed 0 events). Added a real event emission through the same
   reportSensor → outbox → /proctoring/events path the window focus handlers
   use, with an outbox-drained-to-0 assertion, and the matching marker check
   in the script.

REMAINING ISSUES:
- ExamAttempt.deviceInfo was null in the DB for the started attempt — the
  desktop sends deviceInfo, but the backend currently does not persist it on
  the attempt row (it records the client version only via DeviceSession).
  Cosmetic for now; worth wiring when heartbeat/session telemetry is tightened.
- E2E verifies the main-process flow headlessly; it does not click through the
  React UI, and camera/microphone/screen capture remain intentionally out of
  scope (Phase 3B).

NEXT STEP:
Phase 3B — native sensor integration: wire src/media/devices.ts (camera,
microphone, screen) into the exam session so real device state feeds the
already-verified /api/v1/proctoring pipeline, then repeat this E2E including a
device-availability leg.
```
