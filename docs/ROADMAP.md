# ExamGuard — Development Roadmap

Status legend: ✅ **implemented & tested in this repo** · 🏗️ scaffold/contract only · 📐 designed, not started · ⏳ deferred

## Phase 1 — Platform foundation ✅
- [x] Monorepo (pnpm workspaces): `apps/*`, `services/*`, `packages/*`, `infrastructure/*`, `docs/*`
- [x] Database schema (Prisma/PostgreSQL) — full domain incl. future-phase tables (§27)
- [x] Auth: register/login/logout/refresh/forgot/reset; scrypt hashing; JWT access+refresh; tokenVersion revocation
- [x] RBAC: roles/permissions tables, seeded mappings, guards, `CurrentUser`
- [x] Multi-tenancy: org scoping in every service + isolation security tests
- [x] Organizations, users, students, monitors management
- [x] Exam CRUD + settings (security policy per exam, §6)
- [x] Question bank + 7 question types (§7)
- [x] Audit logging (append-only, interceptor + sensitive-flow rows)
- [x] Admin dashboard web app; student dashboard web app; monitor skeleton
- [x] Health endpoints, rate limiting, validation, helmet
- [x] Seed data (super admin, org admin, teacher, monitor, students, sample exam)

## Phase 2 — Exam session core ✅
- [x] Attempt lifecycle: start → autosave answers → heartbeat → submit
- [x] Server-authoritative timer: deadline = startedAt + duration + accumulated pauses (§38)
- [x] Pause/resume server-side enforcement with monitor_action + audit rows (§14–15)
- [x] Termination with confirmation + reason (§16)
- [x] Auto-submit sweeper for ACTIVE attempts past deadline
- [x] Scoring engine (auto-gradable types) with negative marking; manual types marked `score_graded=false`
- [x] Offline-sync contract (client cache + merge by updatedAt) — client side lands with desktop app (Phase 3)
- [ ] Student result release + reports UI (reports API present; UI polish Phase 7)

## Phase 3 — Student secure desktop app 🏗️ (design: `docs/DESKTOP.md` 📐)
- [ ] Electron shell, IPC-isolated renderer, signed updates, version enforcement (API support designed)
- [ ] Windows/macOS/Linux lockdown modules per capability matrix (honest PARTIAL/NO cells)
- [ ] Camera/mic/screen capture + device checks + identity capture
- [ ] Offline encrypted answer cache + sync
- [ ] `student-web` stays as policy-permitted fallback (weaker guarantees, documented)

## Phase 4 — Realtime + live monitoring 🏗️ (contract defined in `packages/types` + `docs/API.md`)
- [ ] `services/realtime`: WebSocket gateway (Redis pub/sub) implementing EventBus contract
- [ ] `services/media`: LiveKit SFU — publish camera/audio/screen; adaptive quality (focused=HD, grid=thumbnails)
- [ ] Monitor web: live grid (2×2…8×8), alert queue, student detail, actions (API complete ✅)
- [ ] Student realtime status indicators (camera/mic/screen/secure session)
- [ ] Messaging delivery (API ✅, delivery via realtime)
- [ ] Evidence capture service (snapshots around events) → object storage

## Phase 5 — AI proctoring + risk engine 🏗️ (risk engine ✅ in `packages/security`; design: `docs/AI-PROCTORING.md` 📐)
- [ ] `services/ai-proctoring` (Python/ONNX): face, head-pose, YOLO object/person, environment-change modules
- [ ] Liveness for identity verification
- [ ] Evidence pipeline + retention worker
- [ ] Incident management UI (monitor/org admin)

## Phase 6 — Mobile monitor app 🏗️ (design: `docs/MOBILE.md` 📐)
- [ ] React Native (Expo) Android + iOS: triage UI, push, stream subscription, actions
- [ ] Mobile device registration + MDM notes

## Phase 7 — Production hardening ⏳
- [ ] Observability (metrics, tracing, error tracking, WebRTC/AI metrics)
- [ ] MFA/TOTP issuance + enforcement; password policy
- [ ] Load tests 100/500/1,000 (plan: `docs/TESTING.md`)
- [ ] k8s manifests + Terraform, CI/CD, secret scanning, dependency audit
- [ ] CSP production build, security headers audit, pen-test checklist
- [ ] Notifications (SMTP/push), reports UI polish, accessibility audit

## Cross-cutting (always on)
- Every security feature: PREVENTION → DETECTION → ALERT → HUMAN DECISION → ENFORCEMENT → AUDIT (§70). AI never auto-fails students. Server is authoritative. No fake security claims (§59). Branding configurable via `packages/config` (§1).