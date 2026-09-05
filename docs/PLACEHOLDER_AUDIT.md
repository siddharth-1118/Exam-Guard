# ExamGuard — Placeholder / Mock Audit

Audited 2026-09-04. This lists every stub, mock, or placeholder found by scanning the repo
(source of truth: file listing + pattern scan + code review; `node_modules`, `.next`, and
`tsbuildinfo` artifacts excluded).

## Category A — README-only directories (no code)

These directories contain a single README describing the intended Phase. There is **no
implementation** behind any of them.

| Path | Intended feature | Contents |
|---|---|---|
| `apps/student-desktop/` | Secure desktop exam app (Windows/macOS/Linux) with lockdown, camera/mic/screen | `README.md` only |
| `apps/monitor-mobile/` | Android/iOS monitor app | `README.md` only |
| `services/realtime/` | WebSocket gateway + event fan-out | `README.md` only |
| `services/media/` | WebRTC/SFU media routing | `README.md` only |
| `services/ai-proctoring/` | CV/AI inference pipeline | `README.md` only |
| `services/notification/` | SMTP/notification worker | `README.md` only |
| `infrastructure/docker/` | Docker build context notes | `README.md` only |

The only marker in code is an honest one — `docker-compose.yml` comment: *"will be added
behind compose profiles when implemented — nothing fake is started."* No fake services are
declared.

## Category B — Contract implemented, backend pipeline real, producer absent

| Location | What is real | What is missing |
|---|---|---|
| `services/api/src/monitoring/events.controller.ts` | `POST /api/v1/proctoring/events`, `POST /api/v1/ai/events`, `POST /ai/events/:id/review` — fully wired to DB, risk engine, audit, event bus (live-tested: 2 AI events → risk score 100 CRITICAL; review → DISMISSED) | The *client* that produces real CV events: `services/ai-proctoring` (models) and `services/media` (streams) do not exist |
| `services/api/src/common/event-bus.ts` | In-process `EventEmitter2` bus, emits `student.connected`, `student.paused`, `ai.alert`, etc. | No WebSocket transport — `services/realtime` README only. Monitor web UI polls REST instead of receiving push |

## Category C — Explicitly marked stubs / dev-only shortcuts

| Location | Marker | Reality |
|---|---|---|
| `services/api/src/auth/auth.service.ts` → `verifyMfa()` | comment: "TOTP issuance lands in Phase 7 hardening; endpoint contract exists (spec §30)" | Returns `{ok:true}` unconditionally — **MOCKED** |
| `services/api/src/auth/auth.service.ts` → `forgotPassword()` | console.log `[DEV] password reset token …` | Real token flow, but delivery is a dev console print; no SMTP. Enumeration-safe (always ok). Reset token is access-scoped (dev convenience) |
| `scripts/dev-db.mjs` | dev helper | Embedded Postgres bootstrap — real (used by the whole dev/test environment) |
| `packages/security/src/index.ts` etc. | — | Real implementations (password, permissions, risk, scoring) — not stubs |

## Category D — Functional gaps found by testing (not marked as TODO in code)

These are behaviors that are missing or partial and surfaced during the audit:

1. `AttemptsService.start` does not enforce `exam.endAt` (start window's end). A student can
   start after the scheduled end as long as status ≠ DRAFT and `startAt` has passed.
2. No "remove question from exam" route (`DELETE /exams/:id/questions/:questionId`).
3. No unassign routes for students/monitors on an exam.
4. No `DELETE`/deactivate route for monitors (students have `PATCH /students/:id`).
5. AI event table has no direct `studentId`/`examId` columns (derived through `attemptId`).
6. Offline-mode UI/cache in the web student runner is absent (heartbeat/reconnect logic on
   the server exists and is tested).
7. Retry of `AUTO_SUBMITTED` sweeper, DISCONNECTED sweep, risk recompute are all real but
   not exercised by an external scheduler beyond `@Interval` in-process.

## Category E — Honest code, not fakes

No code was found that *pretends* to enforce a security control it cannot (no fake
"Alt+Tab blocked" claims, no mocked camera streams, no hardcoded dashboard numbers).
`/reports/dashboard` is DB-computed (verified: totals changed after creating data).
`/health` and `/ready` are real probes. Patterns like `return []` / `return {}` were
searched for and none were found in service code paths that claim functionality.

## Residual scan note

`tsconfig.tsbuildinfo` / `.next` artifacts matched several scan terms (MOCK, TODO) — these
are compiler caches of third-party typings and were excluded as noise. No `TODO`/`FIXME`
markers exist in authored source.
