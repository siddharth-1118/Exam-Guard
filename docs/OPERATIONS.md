# ExamGuard Operations Manual (C52)

## Startup

```bash
# API
cd services/api && node dist/main.js

# Media/SFU
cd services/media && node dist/index.js
```

## Shutdown

Both services handle SIGTERM gracefully:
- API: Drains connections, closes WebSocket gateway, stops sweepers
- Media: Stops FFmpeg processes, closes SFU rooms, releases ports

## Restart

```bash
# Graceful restart (send SIGTERM, wait, then start)
kill -TERM <pid> && sleep 5 && node dist/main.js
```

## Health Checks

| Endpoint | Purpose | Expected |
|---|---|---|
| `GET /health` | Liveness probe | Always 200 if alive |
| `GET /ready` | Readiness probe | 200 if DB reachable |
| `GET /ready/detailed` | Operator diagnostic | Per-dependency status |
| `GET /metrics` | Prometheus metrics | Text/plain exposition |

## Logs

- Application logs: stdout (structured JSON in production)
- Audit logs: PostgreSQL `audit_logs` table
- SFU logs: Media service stdout

## Backups

```bash
# Backup database
./scripts/db-backup.sh ./backups

# Verify backup
sha256sum -c ./backups/examguard_*.sql.gz.sha256
```

## Restore

```bash
# Restore to a NEW database (never overwrite production)
createdb examguard_restore
gunzip -c ./backups/examguard_YYYYMMDD_HHMMSS.sql.gz | psql examguard_restore
```

## Scaling

- API: Horizontal scaling behind load balancer
- Media/SFU: Single instance (mediasoup is single-process)
- PostgreSQL: Vertical scaling + read replicas
- Redis: Single instance (ephemeral state only)

## Storage

- Recordings: Local filesystem (dev) or S3 (production)
- Retention: Configurable per exam (default 90 days)
- Sweeper: Runs hourly, deletes expired recordings

## Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| API 503 | Database down | Check PostgreSQL, restore |
| Recording FAILED | FFmpeg crash | Check logs, restart media |
| Monitor can't see student | SFU room evicted | Student must reconnect |
| MFA locked | Too many failures | Wait 15 minutes |
