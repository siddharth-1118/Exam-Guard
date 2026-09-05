# ExamGuard — Security

## 1. Threat Model

Trust boundaries:
- **Student device** (untrusted, possibly attacker-controlled)
- **Monitor/Admin device** (trusted-but-audited; human errors possible)
- **Network** (untrusted transit)
- **Cloud services** (trusted, hardened)
- **Cloud operators** (administrators — access to private recordings is restricted and audited, spec §3)

| # | Threat | Vector | Layer | Control | Status |
|---|--------|--------|-------|---------|--------|
| T1 | Student calls admin API | Direct HTTP | API | RBAC guard; permission `system:manage` required; security test | ✅ |
| T2 | Cross-org access (A→B data) | orgId tampering in query/body | API | Every query filters `organizationId` resolved from the caller's membership; automated isolation tests | ✅ |
| T3 | Timer manipulation (client clock, speed) | Modified client | Server | Server-authoritative timing; client clock never used (§38) | ✅ |
| T4 | Score forgery | Modified submit payload | Server | Server recomputes score from stored answers + question keys; client score ignored | ✅ |
| T5 | Reused/expired token | Replay of JWT | API | Short-lived access (15m) + rotating refresh with `tokenVersion` revocation on logout | ✅ |
| T6 | Submit after termination | Rogue client | Server | Attempt status machine rejects writes/submits unless ACTIVE (submit blocked when TERMINATED/SUBMITTED) | ✅ |
| T7 | Monitor accesses unassigned student | Direct ID | API | Assignment check (`monitor_assignments`/exam assignment scope) | ✅ (Phase 4 data wired now) |
| T8 | Student disconnects camera/mic/network | Client actions | Detection | Heartbeat + session state machine; `DISCONNECTED` → alert; grace period; monitor notified | ✅ (state) / Phase 4 (realtime) |
| T9 | Alt+Tab / app switching | OS interaction | Desktop | OS-layer lockdown per platform (see capability matrix); focus-loss detection as compensating control | Phase 3 |
| T10 | Screen capture conflicts / virtual display | OS | Desktop | Display detection, `SCREEN_CAPTURE_STOPPED` events | Phase 3 |
| T11 | Deepfake / pre-recorded video | Camera | AI | Liveness signals (blink/head-pose variance) at identity verification + ongoing; assistive only | Phase 5 |
| T12 | Credential stuffing / brute force | Login | API | Rate limiting (`@nestjs/throttler`), bcrypt-scrypt hashing, MFA (Phase 1: enable flag + verify endpoint scaffold; TOTP in Phase 2 hardening) | Partial ✅ |
| T13 | SQL injection / XSS / CSRF | Inputs | API/Web | Prisma parameterized queries; class-validator whitelisting; React escaping; SameSite cookies + origin checks | ✅ |
| T14 | Secret leakage | Repo | CI | `.env.example` only; secrets via env; `.gitignore`; secret-scan in CI (Phase 7) | ✅ |
| T15 | Operator overreach | Admin account | API/audit | Access to private recordings requires explicit authorization; every action in append-only `audit_logs` | ✅ |
| T16 | Recording data breach at rest | Storage | Infra | Encryption at rest (bucket/server-side), signed URLs, retention policies | Phase 4 (contract defined) |
| T17 | Malicious desktop app update | Update channel | Desktop | Signed updates + minimum/blocked version enforcement on backend (§44–45) | Phase 3 |
| T18 | AI false positives → auto-fail | Model | Pipeline | Risk levels only; human decision required (§23–24) | Phase 5 |

## 2. Layered Model for Every Security Feature (§70)

```
PREVENTION → DETECTION → ALERT → HUMAN DECISION → ENFORCEMENT → AUDIT
```

Example — phone detection:

```
AI detects phone → AiEvent(confidence 0.91) → risk +70 → monitor alert
→ monitor reviews camera stream → pauses 5 min (reason required) → server enforces PAUSED
→ MonitorAction + AuditLog rows written
```
No stage short-circuits to "CHEATING = TRUE".

## 3. Authentication & Sessions

- Passwords: scrypt (Node `crypto`) with per-user random salt, `N=2^15, r=8, p=1`, stored as `scrypt$N$r$p$salt$hash`. Never plaintext (spec §30).
- Access token: JWT (HS256, `JWT_SECRET` ≥ 32 bytes), 15 min, claims `sub, role, orgId, permissionsHash?`.
- Refresh token: JWT 7 days, `type=refresh`, bound to `tokenVersion` on the user; logout/security events bump `tokenVersion`, invalidating all outstanding refresh tokens.
- Cookies on web apps: `httpOnly`, `SameSite=Lax`, `Secure` in production; tokens never exposed to browser JS.
- MFA: `mfaEnabled` + `/auth/mfa/verify` endpoint scaffolded; TOTP issuance lands with Phase 7 hardening (documented, not claimed).

## 4. RBAC (enforced server-side)

Roles are seeded in `roles`/`permissions`/`role_permissions` tables (spec §27). Permissions checked by a NestJS guard after JWT auth. Key permission strings:

| Resource | Permissions |
|---|---|
| system | `system:manage` (super admin) |
| organization | `org:manage`, `org:read` |
| user | `user:manage`, `user:read` |
| student | `student:manage`, `student:read` |
| monitor | `monitor:manage`, `monitor:read` |
| exam | `exam:create`, `exam:read`, `exam:update`, `exam:delete`, `exam:assign` |
| question | `question:manage`, `question:read` |
| attempt | `attempt:start`, `attempt:submit`, `attempt:read` |
| proctoring | `proctor:monitor`, `proctor:intervene` |
| audit | `audit:read` |
| report | `report:read` |
| settings | `settings:manage` |

Role → permission mapping (seeded): SUPER_ADMIN = all; ORG_ADMIN = org/user/student/monitor/exam/question/attempt/report/audit(same org)/settings; EXAM_MANAGER = exam/question/student:read/attempt:read/report:read; MONITOR = proctor:monitor, proctor:intervene, exam:read (assigned only), attempt:read (assigned only); STUDENT = attempt:start, attempt:submit, exam:read (assigned only).

## 5. Multi-Tenancy Enforcement

- `CurrentUser` resolver loads the caller's active `OrganizationMember`.
- All service queries that touch owned tables filter `where: { organizationId: user.orgId }`.
- Guards reject cross-org `organizationId` in bodies/params with 403.
- e2e security tests assert A cannot read B's exams/attempts/audit logs (spec §58).

## 6. Audit Logging

`audit_logs` is append-only from the application's perspective (no update/delete routes exist). Every non-GET API call is recorded by an interceptor, and sensitive flows (login, pause, resume, terminate, submission, role changes) write structured rows:

```
who (userId/email) · what (action) · when (timestamp) · org · exam · student
ip · userAgent · sessionId · action · reason · result
```
Only `audit:read` holders (org admin+) can query logs, and only for their org.

## 7. Transport & Data Protection

- TLS everywhere in prod (terminated at LB; HSTS header set by Next/Nest).
- Helmet on API + web apps (secure headers, no sniffing, XSS filter, CSP in prod).
- Rate limiting: `@nestjs/throttler` (global default 100 req/min; auth endpoints 10/min per IP).
- Validation: global `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true, transform: true`).
- Input size limits via `express.json({ limit: '1mb' })`; file upload endpoints (Phase 5) get separate signed handling.
- Secrets: 12-factor; `JWT_SECRET`, `DATABASE_URL`, etc. from environment. Nothing in source (§39).

## 8. Capability Matrix (see `docs/DESKTOP.md` for detail)

| Feature | Windows | macOS | Linux¹ | Android | iOS |
|---|---|---|---|---|---|
| Secure fullscreen | YES | YES | PARTIAL² | NO | NO |
| Clipboard control | YES | PARTIAL³ | PARTIAL | NO | NO |
| Display/external display detection | YES | YES | PARTIAL | NO | NO |
| Camera | YES | YES | YES | YES | YES |
| Microphone | YES | YES | YES | YES | YES |
| Screen capture | YES | YES | YES | PARTIAL⁴ | PARTIAL⁴ |
| Process detection | YES | YES | LIMITED | NO | NO |
| OS-level app-switch lockdown | YES | PARTIAL | LIMITED | NO | NO |
| Signed updates + version enforcement | YES | YES | YES | YES | YES |

¹ Supported distros enumerated in `docs/DESKTOP.md`; capability varies by compositor.
² Compositor-dependent; focus-loss detection is the compensating control.
³ macOS can clear/limit pasteboard; third-party keyboards can interfere.
⁴ Android/iOS only within the app's own content (WebRTC capture of the app's own camera/screen via system pickers); cannot observe other apps.

**We never market PARTIAL/NO as YES.** Where a platform cannot guarantee a restriction, the design adds compensating controls (detection + alert + monitor action) and documents it (spec §59).