# ExamGuard

**Secure online examination, lockdown & live proctoring platform** — brand is configurable in `packages/config` (`BRAND_NAME`).

Real SaaS infrastructure, not a demo: server-authoritative exam timing, RBAC with DB-backed roles/permissions, hard multi-tenant isolation (security-tested), append-only audit logs, and a monitor console whose interventions are enforced server-side. AI proctoring and live media are honestly gated behind later phases (`docs/ROADMAP.md`) — nothing here is faked or over-claimed.

> ⚠️ **Status — Phases 1–2 implemented & tested.** Phase 3+ (desktop lockdown, WebRTC/SFU, AI pipeline, mobile) are *designed* with contracts in place; see `docs/ROADMAP.md` for the exact status of every feature.

## Quickstart

```bash
# 1. Environment (fill JWT_SECRET; defaults are dev-only)
cp .env.example .env

# 2. Dependencies
pnpm install

# 3. Infrastructure (PostgreSQL + Redis)
docker compose up -d

# 4. Database (schema + seed: demo org, roles, exam, questions)
pnpm db:migrate      # interactive first run → name it "init"; afterwards: pnpm db:migrate -- --name <x>
pnpm db:seed

# 5. Run everything (API :4000, admin :3000, student :3001, monitor :3002)
pnpm dev
```

### Demo accounts (dev-only credentials — never for production)

| Role | Email | Password |
|---|---|---|
| Super admin | `superadmin@examguard.dev` | `ExamGuard!Dev2026` |
| Org admin | `admin@northstar.edu` | `ExamGuard!Dev2026` |
| Teacher | `teacher@northstar.edu` | `ExamGuard!Dev2026` |
| Monitor | `monitor@northstar.edu` | `ExamGuard!Dev2026` |
| Students | `student01..05@northstar.edu` | `ExamGuard!Dev2026` |

Portals: admin → `http://localhost:3000` · student → `http://localhost:3001` · monitor → `http://localhost:3002`. Sign in with the account matching the portal.

## Repository layout

```
apps/       admin-web · student-web · monitor-web  (Next.js 15 portals)
            student-desktop · monitor-mobile        (Phase 3/6 — design placeholders)
services/   api (NestJS, implemented) · realtime · media · ai-proctoring · notification (contracts)
packages/   types · config · security (password/RBAC/risk/scoring) · database (Prisma) · auth (JWT/cookies) · ui
infrastructure/ docker (compose at root) · k8s · terraform (Phase 7)
docs/       architecture, security/threat model, API, database, desktop capability matrix,
            mobile, AI proctoring, deployment, testing, privacy, roadmap
```

## Verification

```bash
pnpm typecheck     # TS across all packages/apps
pnpm test          # unit tests (password, RBAC, risk engine, scoring)
pnpm test:e2e      # integration + security suites (needs Postgres running)
```

Security suites (`services/api/test/security.e2e-spec.ts`) cover spec §58 scenarios: cross-org isolation, privilege escalation, expired/revoked tokens, submit-after-termination, server-clock enforcement, DTO whitelisting, rate limiting.

## Documentation

Start with `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`; each subsystem has its own doc. Key honesty guarantees: the platform never claims a restriction its platform layer cannot enforce (`docs/DESKTOP.md` capability matrix), AI never auto-fails students (`docs/AI-PROCTORING.md`), and the server is authoritative for timing, scoring, pause/resume/termination and submission (`docs/SECURITY.md`).