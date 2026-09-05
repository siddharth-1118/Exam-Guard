# Phase 3B — Real Camera + Microphone Status

Date: 2026-09-04 · Desktop: `apps/student-desktop` (Electron 44, React 19)

## Summary

Real camera + microphone are now wired into the exam session and verified end-to-end against the real backend and PostgreSQL, including **real hardware capture with a pixel-level frame check**. Screen capture, lockdown, WebRTC and AI were intentionally not touched.

```
CAMERA:
IMPLEMENTED — real getUserMedia (Chromium/Electron), starts when the exam
      requires it AND the student consented in preflight; reports
      CAMERA_PERMISSION_GRANTED / CAMERA_CONNECTED / CAMERA_DISCONNECTED /
      CAMERA_PERMISSION_DENIED via the existing event vocabulary; mirrors
      CameraSession status (CONNECTING/ACTIVE/FAILED/ENDED) into the backend;
      auto-reconnects on device re-plug. Verified live: camera=ok with real
      non-black frames (E2E_MEDIA cameraFrames=true).

MICROPHONE:
IMPLEMENTED — real getUserMedia audio; MIC_CONNECTED / MIC_DISCONNECTED /
      MIC_PERMISSION_GRANTED / MIC_PERMISSION_DENIED events; MicrophoneSession
      mirror; auto-reconnect. No audio is recorded or transmitted anywhere.
      Verified live: mic=ok.

PREFLIGHT:
IMPLEMENTED — preflight performs REAL per-device acquire→verify→release for
      camera and microphone, a real network check, an informational screen
      row (Phase 3C), display-count warning, and a policy summary with
      explicit consent. A required device that fails blocks the start; an
      optional device only warns. Re-check button re-runs the probes.

PROCTORING EVENTS:
IMPLEMENTED — all device events flow through the existing sensor vocabulary
      (src/shared/sensors.ts mirrors the backend catalog), the ReliableOutbox
      (clientEventId idempotency keys, persistence, retry/backoff) and the
      EXISTING endpoint POST /api/v1/proctoring/events. No new endpoint, no
      duplicate persistence, no fake events (unavailable hardware emits no
      event; only real outcomes do).

OUTBOX:
PASS — 33/33 unit tests, including new coverage for device lifecycle,
      disconnect/reconnect, stop-on-end, and two outbox hardening fixes found
      during the media E2E:
      1) ReliableOutbox.clearAll() on a fresh login — entries from a previous
         account could never be delivered with a new token and previously
         retried into permanent 403s.
      2) pump() now re-checks for due work in a loop — events enqueued while a
         delivery was in flight (the 4-event camera/mic connect burst) no
         longer wait for the next timer tick.

DATABASE VERIFICATION:
PASS — real Postgres rows for the media E2E student (attempt SUBMITTED,
      scoreGraded=true, 1 answer):
        EXAM_WINDOW_LOST_FOCUS   WARNING  clientEventId set
        CAMERA_PERMISSION_GRANTED INFO    clientEventId set
        CAMERA_CONNECTED          INFO    clientEventId set
        MIC_PERMISSION_GRANTED    INFO    clientEventId set
        MIC_CONNECTED             INFO    clientEventId set
      CameraSession status=ENDED, MicrophoneSession status=ENDED (probe and
      exam flow both release every stream; nothing stays active after submit).

EXAM CLEANUP:
PASS — the ExamDeviceController stops and releases all device streams and
      marks sessions ENDED on submit / terminate / unmount; a device lost
      mid-exam raises a DISCONNECTED event (evidence, not accusation) and the
      UI shows “Camera/Microphone not available” until auto-reconnect.

WINDOWS MANUAL TEST:
PARTIAL — automated REAL-device E2E ran on this Windows machine through the
      actual Electron renderer: `node scripts/desktop-media-e2e.mjs` exercised
      getUserMedia for camera AND microphone, verified actual frames via canvas
      pixel sampling (cameraFrames=true), pushed the real device state through
      the real outbox→API→Postgres pipeline, submitted the exam and exited 0.
      Steps that cannot be automated here (physically unplugging the device,
      OS permission dialogs, monitor-visible camera light) are covered by the
      documented manual checklist in docs/DESKTOP.md.

KNOWN LIMITATIONS:
- Device disconnect→reconnect was verified with unit tests (simulated ended +
  devicechange) and real code paths; a physical unplug during a live exam was
  not replayed on hardware in this session.
- Screen capture remains unimplemented in the session (Phase 3C). Exams whose
  policy requires screen monitoring can still start; the preflight shows that
  capability as pending rather than blocking.
- Audio is not transmitted or recorded (by design in this phase).
- Preflight permission prompts are granted through the main-process media
  permission handler; OS-level privacy settings (Windows camera/mic privacy)
  may still deny, which is reported honestly as PERMISSION_DENIED.

NEXT:
Phase 3C — screen capture
```

> Phase 3B verifies camera and microphone availability and device-state monitoring. It does not stream, record, store, or AI-analyze audio/video.

## Files changed (Phase 3B)

| File | Change |
| --- | --- |
| `apps/student-desktop/src/shared/deviceController.ts` | NEW — pure, DOM-free exam device lifecycle controller (camera + microphone): acquire, grant/deny/unavailable, disconnect on track end, bounded auto-reconnect on device change, stop/release on submit/terminate |
| `apps/student-desktop/src/media/devices.ts` | Rewritten: structured `acquireDevice`/`preflightDevice` results, `createBrowserExamEnv` adapter (single live handle per kind, device-change subscription, ended wiring); screen-capture helper retained for Phase 3C, still unwired |
| `apps/student-desktop/src/screens/PreflightScreen.tsx` | Real camera/microphone live checks (acquire → verify → release), required-device gating, policy summary, consent, screen row marked pending (3C) |
| `apps/student-desktop/src/screens/ExamScreen.tsx` | Devices start when the attempt is ACTIVE and the exam requires + student consented; camera/mic status chips in the header; disconnect notice; devices stopped on submit/terminate/unmount |
| `apps/student-desktop/electron/main.ts` | Media permission request/check handler (grants `media` only for our webContents, denies `display-capture`); E2E media-probe step (`EXAMGUARD_E2E_MEDIA=1`) that runs getUserMedia + pixel frame check in the real renderer |
| `apps/student-desktop/electron/outbox.ts` | `clearAll()` on fresh login (stale cross-user entries previously 403-retried forever); `pump()` re-checks for due work in a loop (burst events no longer wait for the next tick) |
| `apps/student-desktop/electron/session.ts` | `login()` clears the outbox for the new account context |
| `apps/student-desktop/test/deviceController.test.ts` | NEW — 8 tests: camera/mic grant, denial, unavailable, disconnect, reconnect, duplicate suppression, stop/release, partial enablement |
| `apps/student-desktop/test/outbox.test.ts` | NEW tests: burst delivery in one pump, `clearAll` |
| `apps/student-desktop/src/styles.css` | `.policy-box` styling |
| `scripts/desktop-media-e2e.mjs` | NEW — real-hardware E2E runner (fixture exam requires camera+mic; asserts live capture + delivery markers) |
| `docs/PHASE_3B_STATUS.md` | This report |
