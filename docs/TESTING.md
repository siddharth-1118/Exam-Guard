# ExamGuard — Testing Strategy

## 1. Test Pyramid

| Layer | Tool | Location |
|---|---|---|
| Unit (pure logic) | Jest + ts-jest | `packages/*` and `services/api/src` (`*.spec.ts`) |
| Integration (API + DB) | Jest + supertest against real Postgres (docker compose) | `services/api/test/*.e2e-spec.ts` |
| Security (authz/isolation) | supertest suites | `services/api/test/security.e2e-spec.ts` |
| Web (component) | Vitest/RTL — Phase 7 | `apps/*` |
| Desktop (OS matrix) | Playwright for UI + OS CI matrix — Phase 3+ | `apps/student-desktop` |
| Load (100/500/1,000) | k6 + livekit-load-test | `docs/load/` — Phase 7, plan below |

## 2. Unit Test Coverage (spec §57)

- **Authentication:** password hash/verify (scrypt format), token issue/refresh/revocation (`tokenVersion` bump invalidates), MFA verify stub.
- **Exam timing:** deadline math with pauses; late-submission rejection; accumulated pause accounting.
- **Scoring:** single/multiple/true-false/numeric; negative marking floor; unanswered; partial credit policy (multi: all-or-nothing default, configurable).
- **Permissions:** role→permission resolution; role hierarchy (org admin can't grant super admin).
- **Risk scoring:** weight accumulation, decay, level bands, configurable weights.
- **Pause/resume/submission:** state machine transitions and guards (already in service layer, tested via integration).

## 3. Integration Test Scenarios (spec §57)

- Exam creation → question linking → student assignment → monitor assignment.
- Attempt lifecycle: start → answer autosave → pause (server-enforced) → resume → submit → score computed.
- Monitor actions: pause/resume/terminate/message/flag with audit + monitor_action rows.
- Answer sync: upsert semantics, deadline clamping.

## 4. Security Test Scenarios (spec §58)

Automated in `security.e2e-spec.ts`:

| # | Scenario | Expected |
|---|---|---|
| S1 | Student token calls admin API | 403/404 |
| S2 | Student modifies exam timer (sends client deadline) | Server ignores; server deadline used |
| S3 | Student modifies score in submit payload | Server recomputes from stored answers |
| S4 | Org A user changes `organizationId` in body/param | 403 + no data leak |
| S5 | Reuse of expired access token | 401 |
| S6 | Refresh token after logout (`tokenVersion` bump) | 401 |
| S7 | Submit after termination | 409 (blocked) |
| S8 | Monitor reads unassigned student's attempt/event | 403 |
| S9 | Monitor calls admin operation | 403 |
| S10 | Camera/mic disconnect → session events + DISCONNECTED state | Events recorded, state transitions |
| S11 | Network disconnect (no heartbeat) → DISCONNECTED; reconnect → ACTIVE (within grace) | State machine |
| S12 | Rate limit on `/auth/login` | 429 after N attempts |
| S13 | Extra fields in DTO | 400 (whitelist) |
| S14 | Cross-org audit log read | 403 |

## 5. Desktop Tests (Phase 3+)

- Per supported OS: launch, device checks, lockdown enters/exits, camera/mic/screen sessions, offline sync, version enforcement (blocked version refuses), update signature validation.
- CI matrix: Windows 10/11, macOS 13/14, Ubuntu 22.04/24.04 (X11 + GNOME Wayland), Fedora 40.

## 6. Load Test Plan (Phase 7, documented now — spec §57)

`k6` scenarios:
- **100 students:** RPS: 100 WS connect, 100 camera+mic+screen streams (via SFU load generator), 5 answers/s autosave, 50 ai.events/s → assert p95 latency < 300ms API, < 1s event fan-out.
- **500 students:** same profile ×5; assert API p95 < 500ms; identify DB hot spots (indexes, connection pool).
- **1,000 students:** 10 API replicas, 3 realtime, 2 LiveKit, 2 AI workers; assert stability over 30 min soak; record max memory/CPU per service.
Results and tuning notes land in `docs/load/reports/` when run.

## 7. Running

```bash
docker compose up -d          # postgres + redis (required for e2e)
pnpm db:migrate && pnpm db:seed
pnpm test                     # unit tests (no DB)
pnpm test:e2e                 # integration + security suites (needs DB)
```