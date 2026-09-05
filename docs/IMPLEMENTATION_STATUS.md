# ExamGuard — Implementation Status

Audited: 2026-09-04 (QA verification pass, live against `:4000` / Postgres `:5433`).

Status legend: **IMPLEMENTED** · **PARTIALLY_IMPLEMENTED** · **PLACEHOLDER** · **MOCKED** · **BROKEN** · **NOT_IMPLEMENTED** · **NOT_TESTABLE**

---

## Core platform (verified working)

| Feature | Expected behavior | Actual implementation | Status | Evidence / files | Known limitations | Next step |
|---|---|---|---|---|---|---|
| Monorepo workspace | pnpm workspace with apps/services/packages | Full pnpm workspace, all packages typecheck | IMPLEMENTED | `pnpm-workspace.yaml`, `package.json` | `@examguard/security` publishes `dist`; rebuild after editing (`pnpm --filter @examguard/security build`) | — |
| API service (NestJS) | Boot, routes, middleware, security headers | Nest 11 app: helmet, compression, CORS allowlist, strict ValidationPipe (whitelist + forbidNonWhitelisted), shutdown hooks | IMPLEMENTED | `services/api/src/main.ts`, `app.module.ts` | CORS origins from env only | — |
| Health / readiness | `/health`, `/ready`; ready reflects DB state | `/health` returns ok; `/ready` runs `SELECT 1` and returns 503 when DB down | IMPLEMENTED | `services/api/src/health/health.controller.ts` | Verified live (`{"checks":{"database":"up"}}`) | — |
| Database schema | All spec §27 entities | 36 models + 21 enums incl. recordings/evidence/notifications | IMPLEMENTED | `packages/database/prisma/schema.prisma` | UUID PKs, `createdAt/updatedAt`, org scoping present | — |
| Migrations + seed | Migrate/seed scripts, idempotent | Migration applied; seed idempotent, refreshes password hashes on re-run | IMPLEMENTED | `packages/database/prisma/seed.ts`, `prisma/migrations/` | Dev-only credentials, clearly marked | — |
| Authentication | Register/login/logout/refresh/me/forgot/reset | Full JWT access+refresh; refresh rotation w/ `tokenVersion` revocation; bcrypt-grade hashing (`@examguard/security`); no-enumeration forgot-password | IMPLEMENTED | `services/api/src/auth/`, `packages/auth/`, `packages/security/src/password.ts` | Reset token logged to console in dev (no mailer yet); MFA endpoint is a stub (see below) | SMTP mailer, MFA TOTP |
| RBAC | 5 roles, permission checks enforced server-side | Roles + 24 permissions + `canGrantRole` hierarchy; global AuthGuard + PermissionsGuard; org scoping in every service | IMPLEMENTED | `packages/security/src/permissions.ts`, `services/api/src/common/guards/` | Student/monitor escalation tested → 403 | — |
| Multi-tenancy isolation | A never reads/writes B | Org filter on every query; cross-org reads return 404 (no existence leak); verified e2e + live | IMPLEMENTED | `services/api/src/exams/exams.service.ts` (`requireOwned`/`requireVisible`) | Frontend filtering not relied on | — |
| Exam CRUD | Create/read/update/delete with validation | Full CRUD + settings + status transitions; delete blocked when attempts exist; validation (name length, duration 1–1440, dates, negative-marking 0–1 after fix) | IMPLEMENTED | `services/api/src/exams/` | **`endAt` not enforced at attempt start** (only `startAt` + status) — MEDIUM | Enforce `endAt` in `AttemptsService.start` |
| Question bank | Bank + all 7 types, link to exam | Bank CRUD, question CRUD for all 7 types, link (append-order), org-isolated | IMPLEMENTED | `services/api/src/questions/` | No "remove question from exam" route (only full question delete); no edit-order route | Unlink route |
| Students / monitors | Create, list, assign to exam | Full create (validated, incl. password policy), list, assign; monitor scope = assigned exams only | IMPLEMENTED | `services/api/src/students/`, `monitors/`, `exams/exams.service.ts` | Unassign not exposed; monitors have no deactivation route (students do) | Unassign routes |
| Exam attempts | Start/read/answers/heartbeat/submit; server-authoritative | Deadline = `startedAt + duration + accumulated pause` on the server; autosave upsert; heartbeat auto-submits at expiry; DISCONNECTED sweep (90 s); auto-submit sweeper (30 s); double-submit/terminated/expired writes rejected | IMPLEMENTED | `services/api/src/attempts/attempts.service.ts` | Client clock never consulted (verified by e2e time-security test) | — |
| Scoring | Server-side, negative marking, all types | Auto-grade MCQ/T-F/NUMERIC (tolerance), manual-grade SHORT/LONG/CODE → score null until graded; exam-level `negativeMarkingValue` now applied (was dead config — fixed) | IMPLEMENTED | `packages/security/src/scoring.ts` | Mixed exams return `score: null` until manual grading (by design) | Manual-grade UI |
| Monitoring interventions | Pause/resume/terminate/message/flag; server-enforced; logged | Status changes on the attempt row; pause freezes clock (accumulated on resume); every action → `monitor_action` + `audit_log` + event-bus fanout; reason/duration required | IMPLEMENTED | `services/api/src/monitoring/monitoring.service.ts` | Verified live: paused student write → 409; terminated submit → 409 | — |
| Proctoring/AI event ingest | Events from client/AI service with risk + human review | `POST /proctoring/events` (student), `POST /ai/events` (proctor), risk recompute from weights, `RiskScore` rows, review (DISMISSED/CONFIRMED/FLAGGED); AI never auto-fails | IMPLEMENTED | `services/api/src/monitoring/events.controller.ts`, `monitoring.service.ts`, `packages/security/src/risk.ts` | AI event row lacks direct student_id/exam_id columns (derived via attempt); alert payload now carries recomputed risk (fixed) | Add denormalized refs |
| Audit log | Append-only, rich rows | GET-only controller (no write route verified); service-level structured rows (login, monitoring.*, attempt.start/submit) + interceptor request-level rows with password/token redaction | IMPLEMENTED | `services/api/src/audit/`, `common/interceptors/audit.interceptor.ts` | Read actions (GET) not logged | — |
| Reports / dashboard | DB-backed stats | Dashboard (students/exams/attempts/risk counts) verified to change as data changes; exam results + proctoring summary endpoints | IMPLEMENTED | `services/api/src/reports/` | Live-exam counters static (no realtime yet) | Realtime integration |
| Rate limiting | Login/sensitive endpoints limited | Global 120/min; auth register+login 10/min per IP (env-tunable `THROTTLE_AUTH_LIMIT`); 429 verified | IMPLEMENTED | `services/api/src/auth/auth.controller.ts`, `app.module.ts` | In-memory (per-instance) storage | Redis-backed storage |
| Web portals (admin/student/monitor) | Functional portals per spec routes | Three Next.js 15 portals; httpOnly-cookie auth; middleware role gating; admin CRUD screens; student exam runner (server timer, autosave, submit); monitor board (assigned exams, students, risk, pause/resume/terminate/message/flag); all typecheck + build | IMPLEMENTED | `apps/admin-web`, `apps/student-web`, `apps/monitor-web` | Web delivery is the fallback path; lockdown/monitoring NOT enforceable in a browser (see matrix) | Desktop client |
| Privacy/consent | Consent record, monitored-state UI | `consent` stored on attempt; privacy/consent docs present; evidence policy config | PARTIALLY_IMPLEMENTED | `docs/PRIVACY.md`, schema `ExamSettings` | No per-recording retention job | Retention sweeper |

## Not implemented / placeholder (honest status)

| Feature | Expected | Actual | Status | Evidence | Next step |
|---|---|---|---|---|---|
| Secure desktop app (Windows/macOS/Linux lockdown, camera/mic/screen, process/display checks) | OS-level lockdown for exam delivery | README only — no code | PLACEHOLDER | `apps/student-desktop/README.md` | Build Electron/Tauri shell per `docs/DESKTOP.md` |
| Realtime (WebSocket) service | Live push of student.connected, ai.alert, monitor.action | README only. API has an internal `EventBus` fan-out and all DB plumbing, but no socket gateway | PLACEHOLDER | `services/realtime/README.md`, `services/api/src/common/event-bus.ts` | Build WS gateway subscribing to EventBus |
| Media / WebRTC SFU | Camera/mic/screen streaming to monitors, adaptive quality | README only | PLACEHOLDER | `services/media/README.md` | LiveKit/mediasoup integration |
| AI proctoring service | Actual CV inference (face, phone, object) | README only. **API contract + DB pipeline (events → risk → review) is real and tested** — only the model side is absent | PLACEHOLDER (pipeline IMPLEMENTED) | `services/ai-proctoring/README.md` | Python + OpenCV/ONNX/YOLO service posting to `/api/v1/ai/events` |
| Notification service (SMTP) | Reset/alert emails | README only; forgot-password logs token to dev console | PLACEHOLDER | `services/notification/README.md` | SMTP worker |
| Mobile monitor (Android/iOS) | Rapid-triage monitoring app | README only | PLACEHOLDER | `apps/monitor-mobile/README.md` | React Native app |
| MFA | TOTP enrollment/verify | Endpoint exists but returns `{ok:true}` unconditionally; no TOTP | MOCKED (honest comment in code) | `services/api/src/auth/auth.service.ts` (`verifyMfa`) | Phase 7 TOTP |
| Offline mode in student web runner | Local answer cache + reconnect sync | Heartbeat/reconnect exist server-side; client cache/offline UI not implemented | PARTIALLY_IMPLEMENTED | `apps/student-web/src/app/student/exam/[examId]/page.tsx` | Client offline store |

## Test status

- Unit (`@examguard/security`): 25/25 PASS — password, permissions/`canGrantRole`, risk engine, scoring.
- e2e (`services/api`): **24/24 PASS** (3 suites, real HTTP + Postgres) — auth, exam lifecycle, security/multi-tenancy. Two regression tests added this audit for fixes below.
- Live probe (`scripts/qa-live-probe.mjs`): **52/52 PASS** against the running API.
- Repo typecheck: clean across all workspaces. All three Next apps build.

## Fixes landed during this audit

1. **Monitors endpoint returned 500 on missing/invalid password** (no DTO existed → validation skipped → `hashPassword(undefined)`). Added `services/api/src/monitors/dto.ts`, wired into controller/service; now 400 + regression test.
2. **`negativeMarkingValue` accepted values >1 and was never applied in scoring.** DTO now constrains 0–1 (fraction, consistent with question-level marks); `AttemptsService.finalizeSubmit` applies the exam-level override. Regression test asserts exact score.
3. **`attempt.start` produced no structured audit row.** Added in `AttemptsService.start`.
4. **AI alert payload always reported `riskScore: 0 / NORMAL`** even after recomputation. `recomputeRisk` now returns the real score/level and the alert carries it.
5. **Auth throttle (10/min) broke full-suite test runs.** Limit is env-tunable (`THROTTLE_AUTH_LIMIT`); test setup (`test/setup-env.ts`) raises it; rate-limit test adapts.
