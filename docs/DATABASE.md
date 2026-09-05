# ExamGuard — Database

PostgreSQL 16, accessed via Prisma (`packages/database`). UUID PKs everywhere (`@default(uuid())`); all material tables carry `created_at` / `updated_at`. Multi-tenant tables carry `organization_id`; **every service query filters on it** (see `docs/SECURITY.md` §5).

## Entity Map (spec §27)

```
Organization
   ├── OrganizationMember (user ↔ org, role)        users (global identity, incl. super admins)
   ├── Student (profile per user)                   Monitor (profile per user)
   ├── Exam ── ExamSettings (1:1 security policy)
   │      ├── ExamQuestion ── Question ── QuestionOption
   │      ├── QuestionBank (org-level) ── Question
   │      ├── ExamAssignment (student ↔ exam)       ExamMonitorAssignment (monitor ↔ exam)
   │      └── ExamAttempt ── Answer
   │               ├── DeviceSession ── CameraSession / MicrophoneSession / ScreenSession
   │               ├── ProctoringEvent ── AiEvent
   │               ├── RiskScore
   │               └── MonitorAction ── Message
   ├── AuditLog (append-only)
   ├── Recording ── Evidence
   └── Notification

RBAC: Role ── RolePermission ── Permission; UserRole (global roles)
```

## Key Tables

### Identity & RBAC
- `users` — email (unique), password_hash, first/last name, `is_active`, `token_version`, `mfa_enabled`, `last_login_at`. Super admins flagged via `UserRole` with SUPER_ADMIN.
- `organizations` — name, slug (unique), plan, status, `settings` (JSONB), `created_by`.
- `organization_members` — `(organization_id, user_id)` unique, `role_id`, `is_active`.
- `roles`, `permissions`, `role_permissions`, `user_roles` — seeded RBAC (spec §27).

### Exams
- `exams` — org FK, name, description, instructions, `start_at`, `end_at`, `duration_minutes`, `max_attempts`, `shuffle_questions`, `shuffle_options`, `negative_marking_enabled`, `negative_marking_value`, `passing_score`, `auto_submit`, status, `created_by`.
- `exam_settings` — 1:1 with exam: `camera_required`, `microphone_required`, `screen_monitoring_required`, `identity_verification_required`, `ai_proctoring_enabled`, `clipboard_policy`, `full_screen_policy`, `app_switch_policy`, `multiple_face_policy`, `phone_object_detection`, `allow_offline_mode`, `evidence_policy`, `retention_days`, plus JSONB `extra`.

### Questions
- `question_banks` — org FK.
- `questions` — org FK, optional bank FK, type enum, text, marks, `negative_marks`, difficulty, `metadata` JSONB (e.g. `{ language: "java" }` for CODE).
- `question_options` — text, `is_correct` (never serialized to students), `order`.
- `exam_questions` — (exam, question), `order`, `marks_override`.

### Attempts (Phase 2 core)
- `exam_attempts` — exam, student, org; status enum `CREATED|READY|ACTIVE|PAUSED|SUBMITTED|AUTO_SUBMITTED|TERMINATED|DISCONNECTED|UNDER_REVIEW`; `started_at`, `submitted_at`, `paused_at`, `accumulated_paused_seconds`, `score`, `score_graded` (false until manual types graded), `auto_submitted`, `time_expired`.
  Server time math: `deadline = started_at + duration_min*60 + accumulated_paused_seconds` (§38).
- `answers` — (attempt, question) unique, `value` JSONB, `is_final`, `synced_from_offline`.

### Devices & media sessions
- `device_sessions` — attempt, OS, app_version, device info JSONB, status, `last_signal_at`.
- `camera_sessions` / `microphone_sessions` / `screen_sessions` — attempt/device FK, status, `started_at`, `ended_at`, `last_signal_at`.

### Proctoring
- `proctoring_events` — attempt FK, type (enum per spec §18/§20), severity, `detail` JSONB, `captured_at`, optional `evidence_id`.
- `ai_events` — attempt FK, `event_type` (FACE_MISSING, MULTIPLE_FACES, PHONE_DETECTED, …), `confidence`, `evidence_ref`, `status` (PENDING|DISMISSED|CONFIRMED|FLAGGED), `captured_at`.
- `risk_scores` — attempt FK, `score` 0–100, level (`NORMAL|LOW|MEDIUM|HIGH|CRITICAL`), `config_snapshot` JSONB, `computed_at`.

### Interventions
- `monitor_actions` — monitor user, attempt, action enum (PAUSE|RESUME|TERMINATE|MESSAGE|FLAG|NOTE), `reason`, `payload` JSONB, timestamps. **The pause/resume/terminate audit trail.**
- `messages` — attempt, from/to, content, kind (PREDEFINED|CUSTOM|SYSTEM), `delivered_at`.

### Evidence & recordings
- `recordings` — attempt, kind (CAMERA|AUDIO|SCREEN), `storage_ref`, retention, status. Retention honored by a worker (Phase 5).
- `evidence` — attempt/event FK, kind (SNAPSHOT|SCREENSHOT|CLIP), `storage_ref`, `captured_at`.

### Audit & notifications
- `audit_logs` — append-only: actor user, org, action, `resource_type`, `resource_id`, `detail` JSONB (reason, before/after), ip, user_agent, `created_at`. No update/delete routes.
- `notifications` — user FK, type, title, body, `data` JSONB, `read_at`.

## Status Machines

**Attempt:** `CREATED → READY → ACTIVE ⇄ PAUSED → SUBMITTED | AUTO_SUBMITTED | TERMINATED`. `DISCONNECTED` is a liveness-derived state; a later heartbeat re-enters `ACTIVE` if the deadline allows, else auto-submits. `UNDER_REVIEW` is set by monitors/admins post-submission (e.g., when an incident is confirmed).

**Exam:** `DRAFT → SCHEDULED → OPEN → CLOSED | ARCHIVED` (Phase 1 uses DRAFT/SCHEDULED/OPEN/CLOSED).

## Indexes

- `exam_attempts (exam_id, student_id)` — active attempts per student per exam
- `exam_attempts (status, deadline computation)` — auto-submit sweeper (adds functional index on `(started_at + duration)` in Phase 2 tuning; swept by query on ACTIVE + `end_at < now()`)
- `proctoring_events (attempt_id, captured_at desc)` — monitor timelines
- `ai_events (attempt_id, status)` — alert queue
- `audit_logs (organization_id, created_at desc)` — log browsing
- `exam_assignments (exam_id, student_id)` unique — idempotent assignment
- `organization_members (organization_id, user_id)` unique

## Retention & Privacy (spec §26)

- Exam-level `retention_days` (default 90). Evidence/recordings are deleted after retention (worker, Phase 5) and subject to org-level deletion requests — a documented admin flow, with `audit_logs` recording the deletion.
- By default `evidence_policy = EVENT_ONLY`: only evidence around flagged events is retained, not continuous footage.

## Migrations

`packages/database/prisma/migrations` — managed with `prisma migrate deploy` (CI/prod) and `prisma migrate dev` (local). See `docs/DEPLOYMENT.md`.