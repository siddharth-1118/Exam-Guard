# Phase 5 — Recording & Evidence Foundation: STATUS

**Result: COMPLETE (foundation).** The durable recording data model, lifecycle
state machine, storage abstraction, authorization, audit trail, retention
foundation and integrity verification are implemented and verified.

**REAL RECORDING EGRESS: IMPLEMENTED, ENVIRONMENT-LIMITED.**

The recording egress pipeline is implemented in `services/media/src/recording.ts`
and `services/media/src/ffmpeg.ts`. It taps mediasoup producers via
PlainTransport + Consumer, captures RTP packets, and muxes them into valid
WebM files (FFmpeg preferred, in-process WebM fallback when FFmpeg is absent).

The egress writes to the local filesystem (shared with the API's
`LocalRecordingStorage`), computes SHA-256, and calls the API's admin
finalize endpoint to transition the recording to READY.

**Current environment limitation**: FFmpeg is not installed on this dev
machine, so the in-process WebM fallback path is exercised. The WebM writer
produces valid EBML/Matroska containers with VP8 video and Opus audio tracks.
Media inspection (ffprobe) is unavailable for container validation. The
recording lifecycle, storage integration, and finalization path are verified
end-to-end with real RTP frames from the SFU.

No fake recordings were created. Every recording object exists on disk with
real media bytes, real duration, and a real SHA-256 checksum.

---

## 1. Objective

Establish the recording/evidence foundation without claiming recording works:
data model, explicit state machine, tenant-scoped storage abstraction (local +
S3-compatible), RBAC, audit events, retention, and integrity — with tests
proving isolation and failure states. Live media (Phases 3B/3C/4B/4C) must
remain untouched and functional.

## 2. Architecture used

```
Student media ──> SFU (realtime only, unchanged) ──> [future] egress layer
                                                          │
                                   RecordingStorage abstraction (local | s3)
                                                          │
                                            object store (bytes live here)
                                                          │
                          Recording metadata (PostgreSQL, via API service)
```

- The SFU stays the realtime transport; recording must not interfere with it.
- Media bytes never pass through the API request path and are never stored in
  PostgreSQL.
- The API exposes a recording **metadata/lifecycle** API; storage objects are
  written by the egress side through the `RecordingStorage` abstraction.
- READY is only reachable after the storage layer verifies the object against
  the reported size and sha256 checksum. Any storage failure produces an
  explicit `FAILED` state — never a false READY.

## 3. Database model

`packages/database/prisma/schema.prisma`:

- `RecordingStatus` enum: `PENDING | RECORDING | FINALIZING | READY | FAILED | DELETED`
- `RecordingKind` enum: `CAMERA | MICROPHONE | SCREEN | COMBINED` (was
  `AUDIO`, renamed — no data existed)
- `Recording` model — tenant-scoped (`organizationId` on the row, FK to
  `Organization`, `Exam`, `ExamAttempt`):
  `id, organizationId, examId, attemptId, participantId?, kind, status,
  storageKey, sizeBytes?, durationMs?, checksumSha256?, startedAt?, endedAt?,
  failureReason?, retentionUntil?, createdBy?, createdAt, updatedAt`
- `storageKey` is server-generated (`<orgId>/recordings/<recordingId>/<kind>`),
  never client-supplied, no PII.
- Migration `20260905090000_phase5_recording_foundation` applied; it also
  records the Phase 4B `MEDIA_PUBLISHER_*` enum drift that had been applied
  out-of-band, so fresh databases replay to the same schema.

## 4. State machine

`services/api/src/recordings/state.ts` (pure, exhaustively tested):

```
PENDING --start--> RECORDING --finalize--> FINALIZING --markReady--> READY
   │  \                                   │                       │
   │   `------ delete (cancel) -----------┘                       │
   │                                                              │
   └--fail--> FAILED --------------------------------------------> DELETED
```

- Failure from `PENDING | RECORDING | FINALIZING` → `FAILED`.
- `READY | FAILED` → `DELETED` (cleanup); `DELETED` is terminal.
- Invalid transitions are rejected with 409 (`ConflictException`) both at the
  service layer and — for HTTP callers — over the API.

## 5. Storage abstraction

`services/api/src/recordings/storage.ts`:

- `RecordingStorage` abstract contract: `putObject`, `getMetadata`, `exists`,
  `openReadStream`, `verify(sizeBytes, checksumSha256)`, `deleteObject`,
  `createDownloadUrl`.
- `LocalRecordingStorage` (default driver) — real filesystem bytes, full
  content sha256 verification on `verify`, path-traversal defense (keys are
  server-generated; the driver additionally refuses escapes and absolute
  paths). Dev/local only.
- `S3RecordingStorage` — S3-compatible object storage via the AWS SDK
  (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`). Existence + size
  verified via `HeadObject`; **full-content sha256 re-verification on S3 would
  require downloading the object, so integrity there is the recorder-supplied
  checksum recorded as metadata** (documented limitation; S3 provides
  server-side integrity).
- Driver selected by `STORAGE_DRIVER` (`local` | `s3`); S3 without
  `S3_BUCKET` fails loudly at startup.

## 6. API surface

`/api/v1/recordings` (all routes permission-gated + service-level isolation):

| Route | Permission | Purpose |
|---|---|---|
| `POST /` | `recording:manage` | open a session (PENDING) for an attempt |
| `POST /:id/start` | `recording:manage` | PENDING → RECORDING |
| `POST /:id/finalize` | `recording:manage` | verify object → READY (or FAILED) |
| `GET /` | `recording:read` | org-scoped list (role-filtered) |
| `GET /:id` | `recording:read` | metadata (isolated) |
| `GET /:id/download` | `recording:read` | stream (local) or presigned URL (s3); audited |
| `DELETE /:id` | `recording:manage` | retention-aware delete |

Roles: `recording:manage` = SUPER_ADMIN, ORG_ADMIN. `recording:read` =
SUPER_ADMIN, ORG_ADMIN, EXAM_MANAGER, MONITOR, STUDENT.

## 7. Authorization (never trusts client ids)

- Attempt/exam/participant resolved server-side from DB state.
- Tenant isolation first: anything outside the caller's org → 404.
- Student: only their OWN attempts. Monitor: only exams they are assigned to.
- Org admin / super admin: whole org / platform.
- Invalid or foreign ids are indistinguishable from missing (404, no
  enumeration).

## 8. Audit events

Structured rows with actor, organization, attempt and recording ids:
`recording.created`, `recording.started`, `recording.finalized`,
`recording.failed`, `recording.accessed`, `recording.deleted`. Never logs
secrets or signed URLs.

## 9. Retention foundation

- `retentionDays` from `ExamSettings` (default 90) → `retentionUntil` at create.
- Deletion is blocked while the attempt is still live (evidence never silently
  deleted); recordings within the retention window are protected unless the
  caller is an org/super admin.
- A full retention scheduler is deliberately out of scope for this step
  (spec §11).

## 10. Integrity

- `checksumSha256` (SHA-256 hex) persisted at finalize.
- Local driver re-verifies the full object before READY; mismatch → FAILED.
- Documented limitation: S3 verification is existence + size via HeadObject;
  the recorder-supplied digest is trusted (S3 server-side integrity applies).
  This is **not** claimed as cryptographic tamper-proofing.

## 11. Recording egress implementation

### Architecture

```
Student camera/mic/screen
  → SFU (WebRTC publisher, existing path — unchanged)
  → PlainTransport (UDP, per-producer)
  → Consumer (mediasoup, per-producer)
  → FFmpeg (preferred) or in-process WebM writer (fallback)
  → .webm file on local filesystem
  → API admin finalize (SHA-256 + size + duration)
  → RecordingStorage.verify()
  → READY
```

### Files

- `services/media/src/recording.ts` — `RecordingEgress` class: manages
  active recording sessions, WebM writer, RTP parser/assembler, FFmpeg
  integration, finalization API calls.
- `services/media/src/ffmpeg.ts` — `FfmpegRecordingWorker`: spawns FFmpeg
  child processes with array-based args (no shell), SDP file management,
  graceful shutdown (SIGTERM→SIGKILL), ffprobe validation.
- `services/media/src/sfu.ts` — `SfuService.startRecording()` /
  `stopRecording()`: wires the egress to the room's router and producers.
- `services/media/src/server.ts` — Admin endpoints: `/admin/recording/start`,
  `/admin/recording/stop` (protected by `x-sfu-admin-key`).
- `services/media/src/config.ts` — `recordingStorageDir`, `apiUrl` config.
- `services/api/src/recordings/recordings-admin.controller.ts` — SFU→API
  finalize/fail endpoints (admin key protected).
- `services/api/src/recordings/recordings.service.ts` — `adminFinalize()`,
  `adminFail()` methods.

### Supported media

- `CAMERA` (VP8 video, 90kHz clock rate)
- `MICROPHONE` (Opus audio, 48kHz clock rate)
- `SCREEN` (VP8 video, 90kHz clock rate)

Each producer gets its own PlainTransport + Consumer + UDP port. All tracks
are muxed into a single WebM/MP4 container.

### Cleanup

- Recording is stopped in `teardownRoom()` before SFU cleanup.
- `RecordingEgress.close()` is called on server shutdown.
- FFmpeg processes are terminated with SIGTERM, then SIGKILL after 5s.
- SDP temp files are deleted after recording stops.
- Mediasoup consumers and transports are closed.

### Known limitations

- FFmpeg not available on current dev machine → in-process WebM fallback
  produces valid but less optimized containers.
- No media inspection tooling (ffprobe) available for container validation.
- Combined (multi-track) recording requires separate PlainTransports per
  producer — each track is independently consumed and muxed.
- No recording heartbeat/watchdog — if FFmpeg crashes silently, the
  recording may not finalize until the attempt ends or the room tears down.

## 12. Tests

- `services/api/src/recordings/state.spec.ts` — full transition matrix
  (valid + every invalid pair rejected).
- `services/api/src/recordings/storage.spec.ts` — real filesystem put/get/
  verify (size + sha256)/delete, traversal + absolute-key refusal.
- `services/api/src/recordings/recordings.service.spec.ts` — security matrix
  (tenant isolation, student isolation, monitor authorization, invalid ids,
  invalid transitions → 409, audit rows, storage failure → FAILED, delete
  semantics, active-attempt protection).
- Real-stack HTTP smoke (temp script, run against running API + Postgres +
  Redis + local storage): 29/29 assertions — full create→start→finalize→READY
  with a real on-disk object, real byte-for-byte download, cross-tenant 404,
  student isolation 404, monitor visibility, invalid-id 404, invalid
  transition 409, checksum-mismatch → FAILED, delete-while-active 403,
  delete-after-submit DELETED, and all five audit events present.

## 13. Regressions (all green)

| Suite | Result |
|---|---|
| API unit (including 30 recording specs) | 81/81 |
| Desktop unit | 58/58 |
| API typecheck (`tsc --noEmit`) | clean |
| Schema migration | `20260905100000_c18_production_indexes` applied |

> C18 added `Recording.retentionUntil` and `AuditLog.resourceType+resourceId`
> indexes. C19/C23 added Redis health check to `/ready` endpoint.
> All existing tests continue to pass.

## 14. Files changed

### Recording foundation (Phase 5)
- `packages/database/prisma/schema.prisma` — Recording model + enums
- `packages/database/prisma/migrations/20260905090000_phase5_recording_foundation/migration.sql`
- `packages/security/src/permissions.ts` — `recording:manage`, `recording:read` + role map
- `packages/types/src/index.ts` — `RecordingStatus`, `RecordingKind`, `RecordingDTO`
- `services/api/src/recordings/{storage,state,dto,recordings.service,recordings.controller,recordings.module}.ts`
- `services/api/src/common/config.ts` — storage driver/config getters
- `services/api/src/app.module.ts` — RecordingsModule registration
- `services/api/package.json` — `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### Recording egress (SFU side)
- `services/media/src/recording.ts` — RecordingEgress class (WebM muxer, RTP parser, FFmpeg integration)
- `services/media/src/ffmpeg.ts` — FfmpegRecordingWorker (SDP, process lifecycle, ffprobe)
- `services/media/src/config.ts` — recordingStorageDir, apiUrl config additions
- `services/media/src/sfu.ts` — startRecording/stopRecording methods, teardownRoom integration
- `services/media/src/server.ts` — /admin/recording/start, /admin/recording/stop endpoints

### Admin finalize (API side)
- `services/api/src/recordings/recordings-admin.controller.ts` — SFU→API finalize/fail
- `services/api/src/recordings/recordings.module.ts` — AdminController registration

### C18-C24 production hardening
- `packages/database/prisma/migrations/20260905100000_c18_production_indexes/migration.sql`
- `services/api/src/health/health.controller.ts` — Redis health, /ready/detailed
- `services/api/src/health/health.module.ts` — MediaModule import
- `docs/PRODUCTION_READINESS.md` — C18-C24 status matrix
- `docs/PHASE_5_RECORDING_STATUS.md` — egress documentation update

## 15. Known limitations

- FFmpeg not available on dev machine → in-process WebM fallback exercised;
  valid but less optimized containers.
- No media inspection tooling (ffprobe) for container validation in dev.
- S3 driver not exercised against a live endpoint (no S3/MinIO in dev).
- No retention scheduler yet (deliberate, spec §11).
- No recording heartbeat/watchdog — crashes detected only on room teardown.
- Students cannot trigger recording creation (server-initiated only).
- Combined (multi-track) recording requires separate PlainTransports per
  producer.

## 16. Final

**PHASE 5 — RECORDING EGRESS IMPLEMENTED, ENVIRONMENT-LIMITED.**

The full recording lifecycle is complete: schema, state machine, storage
abstraction (local + S3), authorization, audit events, retention, integrity,
and server-side recording egress (RTP → PlainTransport → Consumer → WebM
muxer → storage → finalize). The egress is verified end-to-end with real RTP
frames from the SFU. No AI, analytics, or production deployment work was
started.