# ExamGuard — Deployment

## 1. Environments

| Env | Stack | Purpose |
|---|---|---|
| Dev | `docker compose up -d` (Postgres + Redis) + local API/web | This repo, out of the box |
| Pilot | Compose/1-node + LiveKit | ≤100 concurrent students (spec §36 initial target) |
| Production | k8s (orchestration) + managed PG/Redis + object storage + SFU cluster | 500–5,000+ |

## 2. Local Development

```bash
cp .env.example .env          # fill DATABASE_URL, JWT_SECRET, etc.
pnpm install
docker compose up -d          # postgres + redis
pnpm db:migrate               # prisma migrate deploy (dev: migrate dev)
pnpm db:seed                  # demo org, users, exam, questions
pnpm dev                      # api (4000) + admin (3000) + student (3001) + monitor (3002)
```

Ports: API `4000`, admin-web `3000`, student-web `3001`, monitor-web `3002`, Postgres `5432`, Redis `6379`, (future) LiveKit `7880/5349`.

## 3. Environment Variables (`.env.example`, never commit real values)

```
DATABASE_URL=postgresql://examguard:examguard@localhost:5432/examguard?schema=public
REDIS_URL=redis://localhost:6379
JWT_SECRET=<32+ random bytes>
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=604800
API_PORT=4000
APP_ENV=development
CORS_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:3002
STORAGE_ENDPOINT=        # Phase 4 (object storage)
STORAGE_BUCKET=examguard
WEBRTC_SERVER_URL=       # Phase 4 (LiveKit)
AI_SERVICE_URL=          # Phase 5
SMTP_URL=                # Phase 7 (notifications)
```

## 4. Container Topology (production design)

```
LB/TLS ─┬─ apps/*-web (Next.js, serverless or containers)
        └─ services/api (N>1, stateless)
PostgreSQL (managed, replicas) · Redis (managed, cluster)
Realtime (N) ── Redis pub/sub ── API
Media: LiveKit SFU nodes (per region; 1 node ≈ 100+ thumbnail streams)
AI workers (GPU pool) ── consume from queue ── write AiEvents
Object storage (evidence/recordings) + CDN for static assets
```

- API is stateless (sessions in Redis/tokens) ⇒ horizontal scaling.
- Media never traverses the API (SFU only, §35).
- Migrations run as a one-shot job before deploy (`prisma migrate deploy`).
- Health checks: `/health` (liveness) and `/ready` (DB+Redis ping) wired into orchestrator probes.

## 5. Scaling Notes (spec §36)

- **100 students:** 2 API replicas, 1 Redis, 1 Postgres (tuned `shared_buffers`), 1 LiveKit node, 1 AI worker. Safe margin.
- **500:** +2 API replicas, LiveKit ×2, AI ×2, Postgres read replica for reporting, Redis pub/sub only (no in-memory state).
- **5,000+:** per-region deployments, exams sharded across media clusters, queue-backed everything (BullMQ), object storage tiering, CDN, vertical DB (or Citus for multi-tenant sharding — documented option).

## 6. Docker Compose (dev)

`infrastructure/docker/docker-compose.yml` (also at repo root for convenience):

```yaml
services:
  postgres:   postgres:16-alpine (volume, healthcheck)
  redis:      redis:7-alpine
  api:        build services/api (optional in dev; run via pnpm for hot reload)
  # minio:    Phase 4 object storage (S3-compatible) for evidence
  # livekit:  Phase 4 media server
```
Compose profiles (`docker compose --profile media up`) activate Phase 4+ services when implemented — nothing fake is started today.

## 7. Security Operations

- Secrets via env/secret manager; never in images or repo.
- Signed container images, non-root runtime user.
- TLS everywhere; HSTS; CSP in production builds.
- Backup: daily PITR for Postgres, bucket versioning + lifecycle for storage; restore drills documented (Phase 7 hardening).
- Observability: structured JSON logs, `/metrics` (Phase 7), error tracking, WebRTC/AI connection metrics (spec §56).