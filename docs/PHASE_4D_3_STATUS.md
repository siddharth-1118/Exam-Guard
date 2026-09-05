# Phase 4D.3 — Measured 10-Student Realtime Validation: STATUS

**Result: BLOCKED — the test environment cannot host 10 concurrent real-camera
publishers.**

The single physical webcam on this machine (ACER HD User Facing) is
exclusive-use: a second concurrent Chromium `getUserMedia` camera open fails or
hangs regardless of the Windows capture path selected. The Phase 4D.3
acceptance criteria require a real camera producer **per student** (§2/§3/§4,
§17 criteria 1–3), so a 10-student run cannot be honestly performed on this
hardware. Per the phase scope ("if the current architecture cannot support the
test environment, STOP and report the blocker"), no fake/partial camera
substitute was made. This is a **test-hardware blocker, not an ExamGuard
architecture failure**: every real single-publisher media path verifies green.

> This phase produced **no 10-student baseline** and makes **no capacity
> claim**. It did produce a precise blocker diagnosis plus measured
> single/dual-publisher results that bound what this machine can do.

---

## 1. Objective

Prove, with real measurements and real media, that the realtime architecture
(API + mediasoup SFU + Redis presence/ownership + PostgreSQL) can hold 10
simultaneous student publishers (camera + microphone + screen each) with
monitor subscriptions, reconnect, termination isolation, and leak-free cleanup.

## 2. What the acceptance run requires vs. the hardware

| Requirement | Hardware reality |
|---|---|
| 10 overlapping students, each with a real camera producer | One physical webcam; a 2nd concurrent open fails/hangs (see §6) |
| 10 × mic producers | Single default mic — contention observed under load but not the first blocker |
| 10 × screen producers | Whole-display WGC capture is shareable; worked in 2-student runs |
| Monitor subscribers on selected students | Verified working (Phase 4C.1/4C.2 infra; single-publisher monitor path re-verified this cycle) |

## 3. Environment (measured)

- OS: Windows 11 (10.0.26200)
- CPU: AMD Ryzen 5 6600H (12 logical cores)
- RAM: 15.3 GB total (~4.5 GB free during runs)
- Node v24.14.0, Electron 44.1.1, mediasoup 3.14.14
- Redis 8.8.0 (local), PostgreSQL 18.4 (embedded, :5433)
- API :4000 (`THROTTLE_AUTH_LIMIT=600` for the test window), SFU :4010
  (0 rooms baseline), Redis :6379
- Cameras present: **ACER HD User Facing** (only device; exclusive-use). No
  other camera hardware or running virtual-camera host app.
- All 10 publishers would run on **one physical machine** (no VMs), which the
  spec flags as measuring this machine, not a cluster.

## 4. Verified BEFORE the blocker (real passes this cycle)

- **Phase 4B publish E2E — PASS** (`MEDIA_PUBLISH_E2E PASS`): real Electron
  renderer publisher, producers `[camera, screen, microphone]`, SFU byte
  growth, cleanup, tenant/expiry/duplicate negatives.
- **Single-publisher full flow — PASS** (`DESKTOP_MEDIA_E2E PASS`):
  `camera=ok frames=true mic=ok screen=ok screenFrames=true`.
- **2-student run — publisher #1 fully ACTIVE**: `state:"publishing"`
  producers `[camera, screen, microphone]`, Redis presence + ownership live,
  SFU room with 3 producers, DB `MediaParticipant ACTIVE`. Publisher #2 never
  obtained the camera (see §6).
- **Regressions**: API unit 32/32, desktop unit 47/47 (incl. 2 new bounded
  429-retry tests), desktop typecheck clean.
- **Self-cleanup after force-kills**: Redis presence keys expired via TTL
  (4 keys → 0 after ~75 s), DB `MediaParticipant ACTIVE` count → 0, SFU rooms
  → 0. Presence/ownership TTL design from Phase 4D.2 performed correctly.

## 5. Failures encountered and fixed this cycle

1. **API/SFU JWT_SECRET mismatch (real bug found)**: after service restarts,
   the API was launched with a shell `JWT_SECRET` override while the SFU loads
   the repo-root `.env` (`change-me-to-a-long-random-string`). Every publisher
   token was rejected by the SFU: `MEDIA_PUBLISHER_FAILED {code:401,
   "invalid or expired media token"}`. Fix: relaunch the API with the same
   secret source as the SFU (no override; root `.env` supplies it). 4B E2E
   then passed.
2. **Login 429 throttle (product fix)**: 10 concurrent logins from one IP
   exceed the 10/min dev auth throttle. Added bounded retry-on-429 to the
   desktop `login()` (backoff 1.5/3.5/6 s, never retries other statuses) +
   tests. `THROTTLE_AUTH_LIMIT` raised for the test window as documented env
   config.
3. **Publisher E2E deadlines hardcoded**: hold/fail-safe/startup timeouts in
   the desktop E2E publisher are now env-tunable
   (`EXAMGUARD_E2E_PUBLISH_HOLD_MS/_STARTUP_MS`), because 10 staggered
   publishers outlive the original 5-minute budget.
4. **Chromium network-service mass crash in run 1**: 8 of 10 instances died
   simultaneously at device-acquisition when the raised throttle let all 10
   logins cluster. Harness now staggers spawns 12 s apart; no recurrence in
   subsequent runs (the later failures were the camera blocker, not crashes).
5. **E2E capture config**: windows hidden in E2E (RAM); GPU kept ON by default
   with `EXAMGUARD_E2E_NO_GPU=1` opt-out, and the MF/WinRT capture feature
   switches enabled, so concurrent camera sharing is not limited by a
   software-only capture path. None of these made the second camera open
   succeed (§6) — the limit is the device/driver, not Chromium's path.

## 6. The blocker — exact evidence

Reproduced across capture paths with the token/secret issue fixed:

| Trial | Config | Publisher #1 | Publisher #2 camera |
|---|---|---|---|
| 2-student (no-GPU) | hidden + `disableHardwareAcceleration` | CAMERA ● | `CAMERA ERROR` |
| 2-student (GPU) | hidden, GPU on | CAMERA ● | `CAMERA ERROR` |
| 2-student (MF) | + `MediaFoundationVideoCapture` | CAMERA ● | `CAMERA ERROR` |
| 2-student (WinRT MF) | + `MediaFoundationVideoCapture,MediaFoundationVideoCaptureWinRT` | CAMERA ● (`publishing` [camera,screen,microphone]) | `CAMERA ERROR` |
| 2-student (4D.3 harness, fixed tokens) | same | `publishing`, ACTIVE, Redis+DB verified | CAMERA … **pending 240 s+** (never resolves, never errors) |

Single-instance camera always works (real frames). The second concurrent
Chromium `getUserMedia` camera open on this webcam either errors immediately or
hangs forever — the signature of an exclusive-use camera (UMD driver without
frame-server sharing). Windows exposes no second camera; the virtual sources
seen earlier in the session only exist while their host apps run and are not
present now.

10 real camera streams therefore cannot originate from this one machine. The
exam fixture requires `cameraRequired: true` (real ExamGuard product
behavior), so students without a camera never reach the SFU publish state.

## 7. What would unblock Phase 4D.3 (no product change)

- Run the 10 publishers across machines/VMs each with its own webcam (the
  architecture already isolates per participant), or
- Provide ≥ 10 camera sources on one box (10 USB/webcam devices, or
  virtual-camera hosts that support multi-client capture), or
- A different single physical machine whose webcam supports Media Foundation
  frame-server sharing (many modern UVC webcams do) — the 2-student trial is
  the 3-minute gate to re-check.

Re-running is: `node scripts/media-10-student-e2e.mjs`
(services: API :4000 + SFU :4010 + Redis :6379 + dev PG :5433).

## 8. Status

- `docs/REALTIME_10_STUDENT_BASELINE.md` — **not created**: no 10-student
  baseline exists; creating one with this phase's results would be misleading
  (spec §11/§18: no fabricated results).
- Harness `scripts/media-10-student-e2e.mjs` — created, syntax-checked, runs
  end-to-end up to the camera barrier on this machine; asserts fail loudly
  (exit non-zero) as specified.
- **Phase 4D.3: BLOCKED — single exclusive-use webcam prevents 10 concurrent
  real-camera publishers on this test machine.**
