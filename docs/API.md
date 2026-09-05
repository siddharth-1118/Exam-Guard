# ExamGuard — API Specification

Base URL: `/api/v1`. JSON everywhere. Auth: `Authorization: Bearer <accessToken>` (web apps use httpOnly cookies set by their own route handlers, which proxy to this API server-side).

Common response shape:
```json
{ "data": …, "meta": { "page": 1, "pageSize": 50, "total": 12 } }
```
Errors: `{ "statusCode": 401, "message": "Unauthorized", "error": "…" }` — never raw internal errors (spec §55).

## Auth (`/auth`)

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | `{ email, password, firstName, lastName, organizationName? }` | user + tokens | Public. First user of an org name becomes ORG_ADMIN (invite flow is a later enhancement; seeding uses this) |
| POST | `/auth/login` | `{ email, password }` | `{ accessToken, refreshToken, user }` | Rate limited; audit-logged |
| POST | `/auth/logout` | — | `{ ok: true }` | Bumps `tokenVersion` |
| POST | `/auth/refresh` | `{ refreshToken }` | new token pair | Validates `type=refresh`, version, expiry |
| POST | `/auth/forgot-password` | `{ email }` | `{ ok: true }` | Always 200 to avoid enumeration; email out via notification service (Phase 7 wires SMTP; dev logs the reset token) |
| POST | `/auth/reset-password` | `{ token, newPassword }` | `{ ok: true }` | |
| POST | `/auth/mfa/verify` | `{ token }` | `{ ok: true }` | TOTP verify scaffold (issuance is Phase 7) |

## Users / Orgs

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/users` | `user:read` | Org-scoped list |
| POST | `/users` | `user:manage` | Create user + membership (role must be ≤ caller's role) |
| PATCH | `/users/:id` | `user:manage` | Update name/role/active |
| POST | `/users/:id/mfa/enable` | `user:manage` | Phase 7 |
| GET | `/organizations` | `system:manage` or `org:read` | Super admin: all; org admin: own |
| POST | `/organizations` | `system:manage` | Super admin only |
| PATCH | `/organizations/:id` | `org:manage` (own) | |
| GET | `/students` | `student:read` | Org-scoped |
| POST | `/students` | `student:manage` | Binds an existing user to a student profile |
| GET | `/monitors` | `monitor:read` | Org-scoped |

## Exams (`/exams`)

| Method | Path | Permission |
|---|---|---|
| POST | `/exams` | `exam:create` |
| GET | `/exams` | `exam:read` (org-scoped; monitors see assigned) |
| GET | `/exams/:id` | `exam:read` |
| PATCH | `/exams/:id` | `exam:update` |
| DELETE | `/exams/:id` | `exam:delete` |
| POST | `/exams/:id/questions` | `question:manage` — link bank questions w/ order + marks override |
| POST | `/exams/:id/students` | `exam:assign` — `{ studentIds: [] }` creates assignments |
| POST | `/exams/:id/monitors` | `exam:assign` — `{ monitorIds: [] }` creates monitor assignments |
| PATCH | `/exams/:id/settings` | `exam:update` — security policy (`exam_settings`); values per spec §6 |
| GET | `/exams/:id/results` | `report:read` |
| GET | `/exams/:id/proctoring` | `proctor:monitor` / `report:read` — event + risk summary |
| POST | `/exams/:id/start` | `exam:update` — flips status to SCHEDULED/OPEN |
| POST | `/exams/:id/end` | `exam:update` |

Exam create body (abridged):
```json
{
  "name": "Java Programming",
  "description": "", "instructions": "",
  "startAt": "2026-09-10T09:00:00Z", "endAt": "2026-09-10T11:00:00Z",
  "durationMinutes": 90, "maxAttempts": 1,
  "shuffleQuestions": true, "shuffleOptions": true,
  "negativeMarkingEnabled": true, "negativeMarkingValue": 0.25,
  "passingScore": 40, "autoSubmit": true,
  "settings": {
    "cameraRequired": true, "microphoneRequired": true, "screenMonitoringRequired": true,
    "identityVerificationRequired": true, "aiProctoringEnabled": true,
    "clipboardPolicy": "BLOCK", "fullScreenPolicy": "REQUIRED",
    "appSwitchPolicy": "BLOCK", "multipleFacePolicy": "ALERT",
    "phoneObjectDetection": true, "allowOfflineMode": true,
    "evidencePolicy": "EVENT_ONLY", "retentionDays": 90
  }
}
```

## Questions (`/questions`, `/question-bank`)

| Method | Path | Notes |
|---|---|---|
| POST | `/question-bank` | Create bank |
| GET | `/question-bank` | Org-scoped |
| POST | `/question-bank/:id/questions` | `question:manage` |
| GET | `/question-bank/:id/questions` | `question:read` |
| POST | `/questions` | Create standalone (bank optional) |
| PATCH | `/questions/:id` | `question:manage` |
| DELETE | `/questions/:id` | |

Question payload supports the 7 types (§7):
```json
{
  "type": "SINGLE_CHOICE", // | MULTIPLE_CHOICE | TRUE_FALSE | SHORT_ANSWER | LONG_ANSWER | NUMERIC | CODE
  "text": "Which keyword declares a constant?",
  "marks": 1, "negativeMarks": 0.25, "difficulty": "MEDIUM",
  "options": [{ "text": "final", "isCorrect": true, "order": 1 }],
  "metadata": { "language": "java" } // CODE questions
}
```
Correctness flags live server-side; students never receive `isCorrect`.

## Attempts (`/attempts`)

| Method | Path | Notes |
|---|---|---|
| POST | `/attempts` | Start: body `{ examId }`. Creates/validates assignment, device session, returns attempt + questions (answers stripped) |
| GET | `/attempts/:id` | Attempt + answers + server time |
| POST | `/attempts/:id/answers` | `{ questionId, value }` upsert autosave; returns `{ savedAt, serverTime, remainingMs }` |
| POST | `/attempts/:id/heartbeat` | `{ deviceSessionId }`; updates liveness; returns server time + deadline + pause state |
| POST | `/attempts/:id/submit` | Locks answers, computes score for auto-gradable types, `status=SUBMITTED` |
| POST | `/attempts/:id/terminate` | Server-side; used by monitor via `/monitoring` |

Server timing rules (spec §38): `deadline = startedAt + durationMinutes*60 + accumulatedPausedSeconds`. All writes rejected after deadline unless `autoSubmit` already transitioned the attempt. Client-supplied timestamps ignored.

## Monitoring (`/monitoring`)

| Method | Path | Permission |
|---|---|---|
| GET | `/monitoring/exams` | `proctor:monitor` — assigned exams + per-exam counts |
| GET | `/monitoring/exams/:id/students` | `proctor:monitor` — student list w/ status, risk, last signals |
| GET | `/monitoring/students/:id` | `proctor:monitor` — full student detail (identity, sessions, events, AI events) |
| POST | `/monitoring/students/:id/pause` | `proctor:intervene` — `{ durationSeconds, reason }` (30/60/300/600/custom) |
| POST | `/monitoring/students/:id/resume` | `proctor:intervene` — `{ reason }` |
| POST | `/monitoring/students/:id/terminate` | `proctor:intervene` — `{ reason }` (confirmation is a UI contract; the endpoint requires reason and logs it) |
| POST | `/monitoring/students/:id/message` | `proctor:intervene` — `{ content }` |
| POST | `/monitoring/students/:id/flag` | `proctor:intervene` — `{ note }` |

Pause is enforced server-side: attempt `status=PAUSED`, `pausedAt=now`; student clients receive the pause via realtime + on next heartbeat; answering is rejected while paused (spec §14).

## Realtime (Phase 4 contract)

WebSocket at `/socket` (JWT auth). Events (spec §34):
`student.connected|disconnected`, `student.camera.connected|disconnected`, `student.mic.connected|disconnected`, `student.screen.connected|disconnected`, `student.focus.lost|restored`, `student.paused|resumed|terminated|submitted`, `ai.alert`, `monitor.action`, `exam.timer` (server ticks).

## Media (Phase 4 contract)

- `POST /media/token` (API, authed): returns SFU access token + room name `exam-{examId}-{studentId}`.
- Streams: student publishes `camera`, `audio`, `screen`; monitors subscribe with quality adaptation (focused = HD, others = thumbnail).

## Health

- `GET /health` — liveness (`{ status: 'ok', uptime }`)
- `GET /ready` — readiness (DB ping, Redis ping) (`{ status: 'ok', checks: { database: 'up', redis: 'up' } }`)

## Audit

- `GET /audit` — `audit:read`, org-scoped, filterable by `actorId`, `resourceType`, `from`, `to`, `page`.