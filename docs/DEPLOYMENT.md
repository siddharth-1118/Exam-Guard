# ExamGuard Deployment Guide (C52)

## Architecture Overview

```
Internet → Reverse Proxy (nginx) → API (port 4000)
                                  → PostgreSQL (port 5432)
                                  → Redis (port 6379)
                                  → Media/SFU (port 4010)
                                  → Recording Storage (local/S3)
                                  → Monitor Portal (port 3001)
                                  → Admin Portal (port 3002)
```

## Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis 7+
- FFmpeg (for recording egress)
- pnpm 9+

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `development` | Set to `production` |
| `APP_ENV` | Yes | `development` | Set to `production` |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `REDIS_URL` | Yes | - | Redis connection string |
| `JWT_SECRET` | Yes | - | Min 16 chars in production |
| `JWT_ACCESS_TTL` | No | 900 | Access token TTL (seconds) |
| `JWT_REFRESH_TTL` | No | 604800 | Refresh token TTL (seconds) |
| `CORS_ORIGINS` | No | localhost | Comma-separated allowed origins |
| `SFU_URL` | Yes | - | WebSocket URL for SFU |
| `SFU_ADMIN_KEY` | Yes | - | Internal admin key |
| `STORAGE_DRIVER` | No | `local` | `local` or `s3` |
| `S3_BUCKET` | If S3 | - | S3 bucket name |
| `S3_ACCESS_KEY_ID` | If S3 | - | AWS access key |
| `S3_SECRET_ACCESS_KEY` | If S3 | - | AWS secret key |
| `API_PORT` | No | 4000 | API listen port |

## Deployment Steps

### 1. Database Setup

```bash
# Create database
createdb examguard

# Run migrations
cd packages/database
npx prisma migrate deploy

# Seed (development only!)
npx prisma db seed
```

### 2. API Service

```bash
# Build
cd services/api
pnpm build

# Start
node dist/main.js
```

### 3. Media/SFU Service

```bash
# Build
cd services/media
pnpm build

# Start
node dist/index.js
```

### 4. Health Checks

```bash
# Liveness
curl http://localhost:4000/health

# Readiness
curl http://localhost:4000/ready

# Detailed readiness
curl http://localhost:4000/ready/detailed

# Metrics
curl http://localhost:4000/metrics
```

## Docker Deployment

```bash
# Build and start all services
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f api
```

## Production Considerations

- Use a reverse proxy (nginx/HAProxy) for TLS termination
- Use a managed PostgreSQL service (AWS RDS, GCP Cloud SQL)
- Use a managed Redis service (AWS ElastiCache, GCP Memorystore)
- Use S3 for recording storage in production
- Enable PostgreSQL WAL archiving for point-in-time recovery
- Configure monitoring (Prometheus + Grafana)
- Set up alerting (PagerDuty, Slack)
- Use a secrets manager (AWS Secrets Manager, HashiCorp Vault)
