# ExamGuard — Final Test Report

Audited 2026-09-04 by an independent verification pass. Everything below was **executed**,
not assumed: automated suites, live HTTP probes, code inspection with file evidence.

## Executive summary

| Metric | Result |
|---|---|
| Overall status | Core platform (auth → RBAC → multi-tenancy → exams → attempts → monitoring → audit) is genuinely implemented and passing; delivery/security clients (desktop, mobile, realtime, media, AI models) are placeholders |
| Production readiness | **NOT PRODUCTION READY** — see verdict |
| Critical issues | 0 verified |
| High issues | 0 verified |
| Medium issues | 3 (listed below) |
| Low issues | 6 (listed below) |

Test results executed this pass:

- `@examguard/security` unit tests: **25/25 PASS**
- API e2e (real HTTP + Postgres, 3 suites): **24/24 PASS**
- Live verification probe `scripts/qa-live-probe.mjs`: **52/52 PASS**
- Repo-wide `tsc --noEmit`: **clean** · All three Next.js portals: **build clean**
- `pnpm audit`: **5 advisories (3 high, 2 moderate), all transitive dev tooling — no fix-bearing direct dependency**

## Feature matrix

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Authentication (login/register/refresh/logout/me) | ✅ PASS | e2e auth suite 7/7; live probe | refresh revocation via `tokenVersion` tested |
| Password security | ✅ PASS | unit tests; scrypt+salt hash, no plaintext | dev reset token prints to console (no SMTP) |
| MFA | ❌ MOCKED | `verifyMfa()` returns `{ok:true}`; no TOTP | honest comment; Phase 7 |
| RBAC | ✅ PASS | 5 roles, 24 permissions, escalation tests → 403 | permission map: `packages/security/src/permissions.ts` |
| Multi-tenancy isolation | ✅ PASS | e2e org-isolation + live: B reads A exam → 404 | no existence leak (404 not 403) |
| Exam management | ✅ PASS | CRUD + validation live-probed; invalid inputs → 400 | delete blocked when attempts exist |
| Questions (all 7 types) | ✅ PASS | CRUD live-probed; sanitized delivery (no `isCorrect` leak) | no "remove from exam" route |
| Exam attempts / session | ✅ PASS | start→answers→reopen persistence→submit live-verified | consent + device session recorded |
| Autosave | ✅ PASS | answer persists after reopen (live) | upsert per question |
| Server-side timer | ✅ PASS | e2e time-security: past-deadline writes → 409; heartbeat → AUTO_SUBMITTED | client clock never consulted |
| Submission | ✅ PASS | manual submit, double-submit → 409, submit-after-terminate → 409, auto-submit on expiry | scoring server-side |
| Scoring | ✅ PASS | auto (MCQ/MC/T-F/NUMERIC) + manual (null until graded); negative-marking override applied (fixed this pass) | exact-score e2e regression added |
| Exam pause/resume | ✅ PASS | server-enforced; paused writes → 409; pause folds into deadline | reason/duration required, audited |
| Exam termination | ✅ PASS | TERMINATED state; submit after terminate → 409 | audited |
| Monitor messaging/flagging | ✅ PASS | create + audit verified live | delivery = stored; realtime push pending |
| Proctoring event ingest | ✅ PASS | `POST /proctoring/events` live-verified | contract for Phase 3 desktop |
| AI event + risk engine | ✅ PASS (backend) | PHONE+MULTIPLE_FACES → risk 100 CRITICAL live; review DISMISSED works; risk weights configurable per exam | **models/inference absent** (`services/ai-proctoring` README only) |
| Audit logs | ✅ PASS | append-only (no write route); login/monitoring/attempt rows + interceptor rows w/ redaction | GET/read actions not logged (by design) |
| Rate limiting | ✅ PASS | auth 10/min (env-tunable), global 120/min; 429 verified | in-memory per instance |
| Dashboard / reports | ✅ PASS | DB-backed; totals changed after data creation (live) | live counters static until realtime |
| Health/readiness | ✅ PASS | `/ready` probes DB (`SELECT 1`) | 503 when degraded |
| Admin/student/monitor web portals | ✅ PASS | all pages typecheck + build; role-gated middleware + backend | httpOnly cookies; no localStorage |
| WebRTC / SFU media | ❌ NOT_IMPLEMENTED | `services/media` README only | next: Phase 4 |
| Realtime (WebSocket) | ❌ NOT_IMPLEMENTED | `services/realtime` README only; EventBus in-process | next: Phase 4 |
| AI proctoring (models) | ❌ NOT_IMPLEMENTED | `services/ai-proctoring` README only | next: Phase 5 |
| Student desktop + lockdown | ❌ NOT_IMPLEMENTED | `apps/student-desktop` README only | next: Phase 3 |
| Mobile monitor | ❌ NOT_IMPLEMENTED | `apps/monitor-mobile` README only | next: Phase 6 |
| Camera/mic/screen monitoring | ❌ NOT_IMPLEMENTED | DB sessions + API contract exist; no capture | with Phase 3/4 |
| Production hardening (object storage, CDN, k8s) | ❌ NOT_IMPLEMENTED | `infrastructure/` notes only | Phase 7 |
| Observability | ⚠️ PARTIAL | health/ready, structured logs; no metrics/error-tracking | Phase 7 |

## Findings & fixes

### Fixed during this audit (each with regression coverage)

1. **Monitors API 500 on missing password** (`services/api/src/monitors/dto.ts` created;
   now 400). Root cause: no validation DTO existed. Regression: e2e.
2. **`negativeMarkingValue` unbounded and unused.** Now validated 0–1 (fraction) and
   applied in `AttemptsService.finalizeSubmit` as exam-level override. Regression: e2e
   asserts exact score.
3. **No structured `attempt.start` audit row.** Added. Verified in live audit chain.
4. **AI alert always said risk 0/NORMAL.** Now carries the recomputed risk/level.
5. **Auth throttle broke combined test runs.** `THROTTLE_AUTH_LIMIT` env (default 10);
   test setup raises it.

### Remaining findings

Medium:
- **M1 — `exam.endAt` not enforced at attempt start** (`services/api/src/attempts/attempts.service.ts`). Only `startAt`/status gate entry. Fix: reject start when now > endAt.
- **M2 — MFA is a mock** (`auth.service.ts` `verifyMfa`). No TOTP enrollment/verification.
- **M3 — AI-event table lacks direct `studentId`/`examId`** (derived via attempt). Affects audit queries/evidence joins at scale.

Low:
- **L1** — No "remove question from exam" / unassign routes (assign-only).
- **L2** — Forgot-password resets deliver via dev console log (no SMTP).
- **L3** — Offline answer cache UI absent in web runner (server heartbeat/reconnect OK).
- **L4** — Monitor deactivation route missing (students have one).
- **L5** — `pnpm audit`: 3 high (postcss ×2, deepmerge-ts) + 2 moderate — all transitive build-time deps of Tailwind/Next toolchain; no runtime impact, upgrade on the usual cadence.
- **L6** — Throttler storage is in-memory per instance (fine for 1 instance; use Redis at scale).

## Security verdict

**CRITICAL: 0 — HIGH: 0 — MEDIUM: 3 — LOW: 6**

The backend security posture verified as sound where implemented: multi-tenant isolation,
RBAC enforcement server-side, server-authoritative timing, append-only audit, input
validation, no committed secrets, no client-trusted decisions, no fake security claims in
code or docs.

## Final security verdict

**DEVELOPMENT READY** — not PRODUCTION READY and not BETA READY.

Rationale: the implemented core (API + three web portals + database + test suites) is real,
tested, and internally consistent — the natural state to build Phases 3–7 on. The product
**cannot** be called INTERNAL_TEST/BETA/PRODUCTION ready because its defining security
features do not exist yet: the desktop lockdown client, realtime media (WebRTC/SFU), real
AI inference, and the mobile monitor are all README placeholders, and web-only exam
delivery cannot enforce the integrity the spec requires.

## What works / doesn't — the required ten-point summary

1. **Works:** auth+RBCA+multi-tenancy, exam/question CRUD (7 types), server-authoritative attempts (timer/autosave/pause/resume/terminate/submit/scoring), monitoring interventions with full audit, proctoring/AI-event→risk→review pipeline, DB-backed dashboards, rate limiting, health/readiness, three portal apps, 49 automated + 52 live checks.
2. **Does not work:** realtime push, media streaming, AI inference, desktop lockdown, mobile monitor, MFA, offline answer cache, `exam.endAt` enforcement (M1).
3. **Mocked:** MFA endpoint only.
4. **Placeholder:** `apps/student-desktop/`, `apps/monitor-mobile/`, `services/realtime/`, `services/media/`, `services/ai-proctoring/`, `services/notification/`, `infrastructure/` (each README-only).
5. **Fixed this audit:** monitors-DTO 500, negative-marking validation+application, attempt.start audit row, AI-alert risk payload, test-run throttle collision (all regression-tested).
6. **Remains:** Phases 3–7 per `docs/ROADMAP.md`; findings M1–M3 above.
7. **Security vulnerabilities:** none critical/high verified; 5 build-time advisories (L5); MFA absence (M2) is the most material security gap in the delivered API surface.
8. **Platform limitations:** no desktop/mobile client exists; browser cannot enforce OS lockdown (documented in `docs/PLATFORM_SECURITY_MATRIX.md`); Linux lockdown only partly achievable even in the planned client.
9. **Performance limitations:** untested beyond functional loads — no load test exists; WebRTC/100-student claim is unverified (no media layer).
10. **Exact next development phase:** **Phase 3 — secure desktop shell** (`apps/student-desktop/`: session auth, camera/mic/screen capture, focus/process/display sensors reporting to `/api/v1/proctoring/events`), then **Phase 4 — realtime + media** (`services/realtime` WS gateway over the existing EventBus, `services/media` SFU) feeding the already-built monitor dashboards.
