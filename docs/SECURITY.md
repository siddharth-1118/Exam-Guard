# ExamGuard Security Guide (C52)

## Authentication

- JWT access tokens (15min default)
- JWT refresh tokens (7 day default)
- Token rotation on every refresh
- Session revocation via `tokenVersion` bump
- Password hashing: Argon2id/Bcrypt
- Login throttling: 10/min per IP

## MFA (TOTP)

- Enrollment: `POST /auth/mfa/enroll` → QR code + backup codes
- Verification: `POST /auth/mfa/verify` → TOTP or backup code
- Backup codes: 10 one-time-use codes, SHA-256 hashed
- Lockout: 5 failed attempts → 15min cooldown
- Rate limiting: 5 attempts/min on verification

## RBAC

| Role | Key Permissions |
|---|---|
| SUPER_ADMIN | All permissions |
| ORG_ADMIN | org:manage, student:manage, recording:manage |
| EXAM_MANAGER | exam:create, question:manage, attempt:grade |
| MONITOR | proctor:monitor, proctor:intervene, media:subscribe |
| STUDENT | attempt:start, attempt:submit, media:publish |

## Multi-Tenancy

- `organizationId` on every query (server-enforced)
- Cross-tenant access returns NotFound (never data)
- Storage keys are tenant-scoped: `<orgId>/recordings/<id>/<kind>`

## Media Security

- Media tokens: 300s TTL, scoped to participant + role
- SFU admin endpoints: protected by `x-sfu-admin-key`
- Publisher authorization: verified at SFU join
- Subscriber authorization: verified via exam monitor assignment

## Recording Security

- Object keys: server-generated, tenant-scoped
- Signed URLs: 300s TTL (S3 driver)
- Integrity: SHA-256 checksum at finalization
- Access: audited on every download

## Desktop Security

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- DevTools blocked
- Navigation restricted
- Token storage: `safeStorage.encrypt()` (OS keychain)

## Secrets Management

- All secrets via environment variables
- No secrets in code, logs, or API responses
- Audit interceptor redacts password/token/secret fields
- Dev defaults clearly marked as unsafe

## Privacy

- Consent required before monitoring
- GDPR export: `GET /privacy/export/:studentId`
- GDPR deletion: `POST /privacy/delete/:studentId`
- Audit logs preserved after deletion (legal compliance)
