# ExamGuard — Secure Examination & Proctoring Platform

**ExamGuard** is an enterprise-grade secure online examination, lockdown desktop client, and WebRTC live proctoring platform.

---

## 1. System Architecture & Topology

ExamGuard combines high-integrity desktop application lockdown, Mediasoup multi-stream WebRTC live proctoring, server-authoritative schedule enforcement, and advisory AI proctoring detection.

```
       +---------------------------------------------+
       |   Vercel Cloud Hosting (Web Portals)        |
       |   - Student Web & Download Center (:3001)   |
       |   - Admin Web Console (:3000)               |
       |   - Monitor Web Console (:3002)             |
       +---------------------------------------------+
                              |
                              v (REST / WebSockets)
       +---------------------------------------------+
       |   API Backend Service (NestJS :4000)        |
       +---------------------------------------------+
               |                             |
               v                             v
     [PostgreSQL Database]             [Redis Cache]
               ^                             ^
               |                             |
               +--------------+--------------+
                              |
                              v
       +---------------------------------------------+
       |   SFU Media Service (Mediasoup :4010)       |
       +---------------------------------------------+
                              ^
                              | (WebRTC Multi-Stream RTP)
                              v
       +---------------------------------------------+
       |   Student Desktop Client (Electron Kiosk)   |
       |   [Camera + Microphone + Screen Capture]    |
       +---------------------------------------------+
```

---

## 2. Release & Download Center

- **Current Release Version**: `v0.3.0`
- **Release Manifest**: [`release-manifest.json`](file:///e:/projects/examguard/release-manifest.json)
- **Windows Desktop Installer**: `ExamGuard Setup 0.3.0.exe` (`106.67 MB`, SHA-256: `be7a76f8b0fe51e32b7832700cdb5a77db3c15d0442db4ef5302fde1acc7f89d`)
- **macOS / Linux Installers**: Scheduled for automated CI packaging via [`release.yml`](file:///e:/projects/examguard/.github/workflows/release.yml)

---

## 3. Quickstart (Local ₹0 Development Mode)

```bash
# 1. Environment Setup
cp .env.example .env

# 2. Install Workspace Dependencies
pnpm install

# 3. Start Local PostgreSQL Database (Port 5433)
node scripts/dev-db.mjs start

# 4. Deploy Database Migrations
cd packages/database && npx prisma migrate deploy

# 5. Start SFU Media Daemon (Port 4010)
pnpm --filter @examguard/media start:prod

# 6. Start API Backend Service (Port 4000)
$env:DATABASE_URL="postgresql://examguard:examguard@localhost:5433/examguard?schema=public"
node services/api/dist/src/main.js

# 7. Start Student Web Portal & Download Center (Port 3001)
pnpm --filter @examguard/student-web dev
```

---

## 4. Documentation Index

- [`docs/DEPLOYMENT_ARCHITECTURE.md`](file:///e:/projects/examguard/docs/DEPLOYMENT_ARCHITECTURE.md) — System topology, component interactions, and hosting boundaries
- [`docs/ENVIRONMENT_VARIABLES.md`](file:///e:/projects/examguard/docs/ENVIRONMENT_VARIABLES.md) — Complete environment variable reference across all packages
- [`docs/EXAM_SCHEDULING.md`](file:///e:/projects/examguard/docs/EXAM_SCHEDULING.md) — Server-authoritative timing calculations and Cases A–H schedule matrix
- [`docs/MONITORING.md`](file:///e:/projects/examguard/docs/MONITORING.md) — Student ↔ Monitor WebRTC streaming architecture, pause controls, and metrics
- [`docs/SECURITY.md`](file:///e:/projects/examguard/docs/SECURITY.md) — Electron renderer isolation, shortcut interception, and platform lockdown boundaries
- [`docs/DESKTOP_RELEASES.md`](file:///e:/projects/examguard/docs/DESKTOP_RELEASES.md) — Packaging pipeline, release manifest schema, and GitHub Releases workflow
- [`docs/DEPLOYMENT.md`](file:///e:/projects/examguard/docs/DEPLOYMENT.md) — Environment separation (Local, Staging, Production) and rollback safety
- [`docs/PRODUCTION_READINESS.md`](file:///e:/projects/examguard/docs/PRODUCTION_READINESS.md) — Complete 73-checkpoint verification matrix and audit log

---

## 5. Verification & Test Suite

```bash
# Workspace Typecheck (13/13 packages clean)
pnpm --recursive typecheck

# Full Unit & Integration Test Suite (208/208 tests passing)
pnpm --filter @examguard/api test
pnpm --filter @examguard/student-desktop test
pnpm --filter @examguard/security test
pnpm --filter @examguard/ai-proctoring test
pnpm --filter @examguard/media test

# Run Automated Deployment Smoke Test
node scripts/deployment-smoke-test.mjs
```