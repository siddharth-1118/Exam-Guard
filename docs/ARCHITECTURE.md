# ExamGuard — Architecture

> Product name is a configurable placeholder. The brand string lives in `packages/config` (`BRAND_NAME`) and is consumed by every app; rebranding requires changing one value.

## 1. Design Principles

1. **The server is authoritative.** Exam timing, pause/resume, submission deadlines, scoring, and authorization are enforced server-side. The student client is treated as untrusted input, never as an enforcement point.
2. **No fake security.** Every restriction the product claims is implemented at the layer where it can actually be enforced (OS/application layer for the desktop app), or documented as partially supported with compensating controls. We never claim "JavaScript prevents Alt+Tab" or "fullscreen means the machine is locked."
3. **Prevention ≠ detection ≠ judgment.** Layered controls separate: prevention (lockdown), detection (sensors/AI), alert (risk engine), human decision (monitor/admin), enforcement (server-side actions), and audit (immutable logs). An AI alert alone never fails a student.
4. **Security > correctness > reliability > scalability > usability > polish** (spec §73). Usability is still a first-class requirement, but never at the cost of a security property.
5. **Multi-tenancy is enforced in the data layer.** Every organization-owned resource query carries `organizationId` filtering; cross-tenant access is a security test, not just a UI concern.

## 2. System Context

```
                         EXAMGUARD CLOUD
                              |
             +----------------+----------------+
             |                |                |
             v                v                v
        Admin Portal    Monitor Portal    API/Backend
                                                |
                    +---------------------------+-----------------------+
                    |                           |                       |
                    v                           v                       v
              PostgreSQL                    Redis                Object Storage
                    |
                    v
             Realtime/Event Layer
                    |
          +---------+----------+
          |                    |
          v                    v
     WebSocket             WebRTC/SFU
                               |
              +----------------+----------------+
              |                |                |
              v                v                v
          Monitor 1         Monitor 2        Monitor N


STUDENT SIDE

+---------------------------------------------------------+
|                 ExamGuard Secure App                   |
|                                                         |
| Exam UI + Lockdown + Camera + Microphone + Screen      |
| monitoring + Device checks + Security event detection  |
+---------------------------+-----------------------------+
                            |
                            v
                       Exam Backend
                            |
                            v
                       AI Pipeline
                            |
                            v
                     Risk/Alert Engine
                            |
                            v
                     Human Monitor
```

## 3. Component Breakdown

| Component | Tech | Status | Notes |
|---|---|---|---|
| `apps/admin-web` | Next.js 15 (App Router) + Tailwind | Phase 1 ✅ | Organization management, exam CRUD, RBAC |
| `apps/student-web` | Next.js 15 | Phase 1–2 ✅ | Assigned exams, exam-taking flow (server-authoritative timer, autosave, submit). Web delivery is a fallback; the secure desktop app is the primary student surface. |
| `apps/monitor-web` | Next.js 15 | Phase 4 (skeleton ✅, live media pending) | Live grid, alerts, pause/resume/terminate/message |
| `apps/student-desktop` | Electron shell + native modules | Phase 3 — designed, not built | OS-level lockdown; see `docs/DESKTOP.md` |
| `apps/monitor-mobile` | React Native | Phase 6 — designed, not built | Triage-first mobile monitor; see `docs/MOBILE.md` |
| `services/api` | NestJS 11 + Prisma + PostgreSQL | Phase 1–2 ✅ | Versioned REST API; authoritative for all business rules |
| `services/realtime` | WebSocket gateway (Socket.IO or native) | Phase 4 — designed, contract defined | Fan-out of `student.*`, `ai.alert`, `monitor.action` events |
| `services/media` | LiveKit SFU | Phase 4 — designed, not built | WebRTC ingest/relay; **never** routed through the API server |
| `services/ai-proctoring` | Python + ONNX Runtime + MediaPipe/YOLO | Phase 5 — designed, not built | Assistive detection; emits events + evidence refs, never verdicts |
| `services/notification` | Queue worker (Redis + BullMQ) | Pending | Email/push delivery |
| `packages/*` | Shared TS libraries | ✅ | types, config, security, database, auth, ui |
| `infrastructure/*` | Docker Compose (dev), k8s/Terraform (prod, designed) | Compose ✅ | see `docs/DEPLOYMENT.md` |

## 4. Key Architectural Decisions & Tradeoffs

### 4.1 WebRTC media path (SFU, not server-relayed)
Camera/audio/screen streams go student → SFU → monitor. The API server only carries signaling metadata. This keeps the control plane cheap and lets media scale horizontally. When a monitor focuses a student, the SFU forwards high bitrate for that one stream and low-bitrate thumbnails for the rest (adaptive quality, spec §12, §35).

### 4.2 Desktop lockdown honesty (spec §10, §59)
Browser fullscreen cannot enforce OS-level restrictions. The desktop app is the primary student surface:
- Windows: Win32 APIs (`SetWindowDisplayAffinity`, keyboard hook), process enumeration — **strongest** platform.
- macOS: Screen Recording/TCC permissions, `NSWorkspace` observation — strong, but an admin can always unlock a Mac; we document it.
- Linux: X11/Wayland depend on compositor; **supported distros are enumerated** (see `docs/DESKTOP.md`), capability matrix marks what is `LIMITED`/`NOT SUPPORTED` honestly.

### 4.3 Server-authoritative timing (spec §38, §37)
- Exam end time = `startedAt + duration + accumulatedPausedTime`.
- The client shows a countdown for UX, but the server rejects late submissions, clamps answer writes after deadline, and auto-submits on a server timer for ACTIVE attempts whose deadline passed.
- Offline mode: client caches answers locally (encrypted at rest), heartbeats with monotonic counters, and syncs on reconnect. Time never comes from the client clock.

### 4.4 Multi-tenancy
`organization_id` on every owned table. All service queries filter by the caller's resolved organization. A super admin has explicit, audited elevation only. Cross-org access is covered by automated security tests (`services/api/test`).

### 4.5 Realtime contract decoupled from transport
`packages/types` defines the event vocabulary (`student.connected`, `ai.alert`, `monitor.action`, …). The API currently emits these through a thin `EventBus` interface backed by an in-process emitter; `services/realtime` will implement the same interface over WebSockets/Redis pub-sub in Phase 4 without changing call sites. This is an honest seam: the bus exists and works in-process today; the WebSocket transport is a documented Phase 4 task, not silently claimed.

## 5. Request Flow (example: monitor pauses a student)

```
Monitor (monitor-web / mobile)
   │  POST /api/v1/monitoring/students/:id/pause  { duration, reason }
   ▼
AuthGuard (JWT) ──► RBAC Guard (permission proctor:intervene)
   ▼
MonitoringService
   ├─ verify attempt belongs to monitor's assigned exam/org
   ├─ enforce server-side pause (pausedAt, status=PAUSED)
   ├─ MonitorAction row + AuditLog row
   └─ EventBus.emit('student.paused', …)
   ▼
services/realtime (Phase 4) ──► student app shows PAUSED screen (server-enforced)
```

## 6. Data Flow: student answer autosave

```
Student app ── POST /attempts/:id/answers ──► API
   ├─ validate attempt status is ACTIVE/PAUSED(?) and deadline not passed
   ├─ upsert Answer (updatedAt, isFinal=false)
   └─ 200 { savedAt, serverTime }
Offline: local encrypted store ──► on reconnect POST (batch) ──► server merges by updatedAt
```

## 7. Scaling Path (spec §36)

| Tier | Students | Notes |
|---|---|---|
| Dev | 1–20 | Single API replica, in-process event bus, Dev SFU |
| Pilot | 100 | Compose/1 replica API + Redis pub-sub, LiveKit SFU (1 node), Postgres tuned |
| Production | 500 | API ×N behind LB, realtime service ×N, Postgres read replicas, object storage for recordings |
| Large | 5,000+ | Shard exams across media clusters, per-region deploy, CDN for static assets, queue everything |

Initial target **100 concurrent students** is achievable with: 2× API replica, 1 Redis, 1 Postgres, 1 LiveKit node (1:100+ streams is well within LiveKit's per-node envelope at thumbnail quality), 1 AI worker. See `docs/DEPLOYMENT.md`.

## 8. Honest Contradictions & Limitations (spec §73.2)

1. **"Secure" fullscreen vs. OS reality.** No consumer OS offers a fully tamper-proof exam mode. We implement the strongest layer available per platform and *detect* (not prevent) the rest — e.g., Linux cannot prevent alt-tab on all compositors, so we detect focus loss and alert the monitor.
2. **AI proctoring is probabilistic.** Face/phone detectors produce false positives. Hence suspicion levels (`LOW→CRITICAL`) and mandatory human review; never auto-verdicts.
3. **Screen capture vs. DRM content.** Some OSs (macOS, Windows) may block capture of protected content; we detect capture failure and surface `SCREEN_CAPTURE_STOPPED`/`SCREEN_PERMISSION_REVOKED` events rather than silently proceeding.
4. **Privacy vs. surveillance.** Continuous recording is opt-in per exam policy with retention limits; by default we record only *evidence around events* (configurable, spec §25, §26).
5. **Mobile OSs can't fully lock down.** iOS/Android apps run sandboxed; the mobile app is a *monitor*, and future student mobile delivery will be documented as "best-effort with compensating controls," never marketed as equivalent to desktop lockdown.
6. **Time manipulation.** Student changes system clock — irrelevant, because the server is authoritative for all timing decisions (spec §38).
7. **100 concurrent full-res streams is unrealistic on one monitor's machine.** Adaptive quality (1 focused high-res + N thumbnails) is the only sane design; grid sizes 2×2…8×8 render thumbnails.

## 9. Environments & Tooling

- Node 20+ (developed on 24), pnpm 11, TypeScript strict.
- PostgreSQL 16 + Redis 7 via `docker compose up -d` (dev).
- `pnpm -r typecheck`, `pnpm -r test`, per-app `next build`.
- Linting: ESLint flat config at root (Phase 7 hardens CI; local lint present).

## 10. Recording & Evidence (Phase 5 foundation)

Recordings are **metadata in PostgreSQL + objects in storage** — media bytes
never pass through the API and never live in the DB. The SFU remains the
realtime transport; a future egress layer writes objects through the
`RecordingStorage` abstraction (`services/api/src/recordings/storage.ts`),
then the API lifecycle marks a recording READY **only after storage verifies
the object's size and sha256 checksum**. Failure lands in an explicit FAILED
state. Keys are server-generated and tenant-scoped
(`<orgId>/recordings/<id>/<kind>`); authorization, audit (`recording.*`) and
retention follow the same rules as the rest of the platform.

Real egress is NOT yet available (no SFU RTP tap, no S3 endpoint locally) —
this is documented in `docs/PHASE_5_RECORDING_STATUS.md`, and no placeholder
or fake recordings exist.

## 11. Related Documents

- `docs/SECURITY.md` — threat model, controls, capability matrix
- `docs/DATABASE.md` — schema and relationships
- `docs/API.md` — endpoint specification
- `docs/DESKTOP.md` — desktop app + OS capability matrix
- `docs/AI-PROCTORING.md` — detection pipeline and human-in-the-loop
- `docs/PRIVACY.md`, `docs/DEPLOYMENT.md`, `docs/TESTING.md`, `docs/MOBILE.md`, `docs/ROADMAP.md`