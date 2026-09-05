# ExamGuard Deployment & Environment Guide (Phase 12 & 13)

This document provides deployment guidelines for Local ₹0 testing, Staging, and Production environments.

---

## 1. Environment Separation Strategy

ExamGuard enforces strict environment isolation to prevent dev/prod credential leakage and ensure reliable testing.

```
                  +-----------------------------------+
                  |         ENVIRONMENT MATRIX        |
                  +-----------------------------------+

     LOCAL (₹0 Setup)              STAGING                    PRODUCTION
  +--------------------+    +--------------------+    +--------------------+
  | Node / pnpm        |    | Docker Compose     |    | Cloud Containers   |
  | Local PostgreSQL   |    | Staging Postgres   |    | AWS RDS Postgres   |
  | Local Redis        |    | Redis Container    |    | AWS ElastiCache    |
  | Local Storage      |    | Local / S3 Test    |    | AWS S3 Bucket      |
  | Mediasoup (Local)  |    | Mediasoup (Host)   |    | SFU Cluster        |
  +--------------------+    +--------------------+    +--------------------+
```

| Environment | Database URL | Media Target | Storage Driver | Node Mode |
| :--- | :--- | :--- | :--- | :--- |
| **Local (₹0)** | `postgresql://examguard:examguard@localhost:5433/examguard` | `ws://localhost:4010` | `STORAGE_DRIVER=local` | `NODE_ENV=development` |
| **Staging** | `postgresql://user:pass@staging-db:5432/examguard` | `wss://staging-media.examguard.io` | `STORAGE_DRIVER=s3` | `NODE_ENV=production` |
| **Production** | `postgresql://prod-user:secret@rds-host:5432/examguard` | `wss://media.examguard.io` | `STORAGE_DRIVER=s3` | `NODE_ENV=production` |

---

## 2. Local ₹0 Development & Deployment

The local environment requires **zero cloud costs** and relies entirely on local daemons:

```bash
# 1. Start Local PostgreSQL (Port 5433)
node scripts/dev-db.mjs start

# 2. Deploy Prisma Schema
cd packages/database && npx prisma migrate deploy

# 3. Start SFU Media Server (Port 4010)
pnpm --filter @examguard/media start:prod

# 4. Start API Backend Service (Port 4000)
$env:DATABASE_URL="postgresql://examguard:examguard@localhost:5433/examguard?schema=public"
node services/api/dist/src/main.js

# 5. Start Student Web Portal (Port 3001)
pnpm --filter @examguard/student-web dev
```

---

## 3. Production Docker Compose Deployment

```bash
# Build and launch production stack in background
docker compose -f docker-compose.production.yml up -d

# Verify container status
docker compose -f docker-compose.production.yml ps

# Execute smoke test script
node scripts/production-smoke-test.mjs
```

---

## 4. Rollback Procedure & Operational Safety

### Container Rollback
If a newly deployed container image fails post-deployment health checks:
```bash
docker compose -f docker-compose.production.yml up -d --no-deps api media
```

### Database Recovery & Restore
Take an explicit snapshot prior to schema migrations:
```bash
pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME -F c -b -v -f pre_deploy_backup.dump
```
To restore a snapshot:
```bash
pg_restore -h $DB_HOST -U $DB_USER -d $DB_NAME --clean --if-exists pre_deploy_backup.dump
```
