# Phase 5 — Recording & Evidence Foundation: STATUS

**Result: COMPLETE (foundation).** The durable recording data model, lifecycle
state machine, storage abstraction, authorization, audit trail, retention
foundation and integrity verification are implemented and verified.

**REAL RECORDING EGRESS: NOT YET AVAILABLE IN CURRENT ENVIRONMENT.**
No fake recordings were created. The SFU/mediasoup layer does not yet tap RTP
for recording, and this environment has no S3 endpoint — so the system
implements and tests the full recording lifecycle and storage abstraction, and
explicitly refuses to mark a recording READY unless a real object exists in
storage and matches the reported size/checksum. Wiring a real egress (RTP →
container muxer → object storage) is a later Phase 5 step.

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

## 11. Environment limitation (honest)

`REAL RECORDING EGRESS: NOT YET AVAILABLE IN CURRENT ENVIRONMENT` — no RTP
egress taps exist in the SFU and there is no S3 endpoint here. The lifecycle,
storage abstraction and failure paths are fully implemented and tested; no
placeholder recordings, fake URLs or fabricated durations exist anywhere.

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

## 13. Regressions (all green after this phase)

| Suite | Result |
|---|---|
| API unit | 60/60 |
| API e2e (real DB/Redis) | 25/25 |
| Desktop unit | 47/47 |
| `packages/types` / `packages/database` typecheck | clean |
| API `nest build` | clean |
| Phase 4B media publish E2E | PASS (real camera+mic+screen producers, SFU byte growth, cleanup) |

> Note: the first 4B E2E attempt in this run hit this machine's known
> transient camera-pending behavior (single exclusive webcam after prior
> force-killed captures) and passed immediately on retry — the same
> environmental failure mode documented in Phase 4D.3, not a regression.

## 14. Files changed (this phase)

- `packages/database/prisma/schema.prisma` — Recording model + enums
- `packages/database/prisma/migrations/20260905090000_phase5_recording_foundation/migration.sql`
- `packages/security/src/permissions.ts` — `recording:manage`, `recording:read` + role map
- `packages/types/src/index.ts` — `RecordingStatus`, `RecordingKind`, `RecordingDTO`
- `services/api/src/recordings/{storage,state,dto,recordings.service,recordings.controller,recordings.module}.ts`
- `services/api/src/common/config.ts` — storage driver/config getters
- `services/api/src/app.module.ts` — RecordingsModule registration
- `services/api/package.json` — `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

## 15. Known limitations

- No real egress (SFU RTP tap → muxer → storage) yet; recording sessions are
  driven by the API lifecycle and verified against storage.
- S3 driver not exercised against a live endpoint in this environment
  (no S3/MinIO available); it is type-checked and built.
- No retention scheduler yet (deliberate, spec §11).
- Students cannot trigger recording creation (only org admins/super admins);
  per-attempt auto-creation on attempt start is future wiring once egress
  exists.

## 16. Final

**PHASE 5 — RECORDING FOUNDATION COMPLETE** (foundation only; real egress is
explicitly out of scope and unclaimed). No AI, analytics, or production
deployment work was started.