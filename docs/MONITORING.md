# ExamGuard Monitoring & Alerting Contract (C51)

## Metrics Endpoint

ExamGuard exposes Prometheus-compatible metrics at `GET /metrics`.

### Available Metrics

| Metric | Type | Description |
|---|---|---|
| `examguard_http_requests_total` | counter | Total HTTP requests by method, route, status |
| `examguard_http_request_duration_seconds` | histogram | Request latency distribution |
| `examguard_attempts_active` | gauge | Currently active exam attempts |
| `examguard_media_participants` | gauge | Active media participants |
| `examguard_recordings_active` | gauge | Active recording sessions |
| `examguard_redis_health` | gauge | Redis connectivity (1=healthy, 0=unhealthy) |
| `examguard_auth_failures_total` | counter | Failed authentication attempts |
| `examguard_mfa_failures_total` | counter | Failed MFA verification attempts |

### Label Policy

Labels are bounded and never include high-cardinality values:
- ❌ studentId, email, IP, recordingId, attemptId
- ✅ method, route (normalized), status, role

## Alert Rules

### CRITICAL Alerts

| Alert | Condition | Operator Action |
|---|---|---|
| API Unavailable | `/health` fails for >1min | Restart API service, check logs |
| Database Unavailable | `/ready` reports DB down | Check PostgreSQL, restore if needed |
| Redis Unavailable | `examguard_redis_health = 0` for >5min | Check Redis, restart if needed |
| SFU Unavailable | Media service health fails | Restart media service |
| Recording Failure Spike | `recordings_failed` increases rapidly | Check FFmpeg, storage, network |
| Storage Failure | Recording finalization fails repeatedly | Check disk space, S3 credentials |

### WARNING Alerts

| Alert | Condition | Operator Action |
|---|---|---|
| Elevated API Latency | p95 > 500ms for >5min | Check database queries, connection pool |
| Elevated 5xx | Error rate > 5% for >5min | Check logs, identify failing endpoints |
| Elevated Reconnects | Media reconnects spike | Check network stability |
| Recording Finalization Delay | Finalization > 30s | Check FFmpeg, storage I/O |
| High CPU/Memory | > 80% for >10min | Scale horizontally or investigate |
| Disk Usage | > 85% | Clean old recordings, expand storage |

## Dashboard Recommendations

### Grafana Dashboards

1. **API Overview**: Request rate, latency, error rate, active attempts
2. **Media Health**: Participants, reconnects, SFU rooms, producers/consumers
3. **Recording Pipeline**: Active recordings, finalization time, failures
4. **Security**: Auth failures, MFA failures, rate limiting activity
5. **Infrastructure**: Redis health, database connections, disk usage

## Escalation

| Severity | Response Time | Escalation |
|---|---|---|
| CRITICAL | < 15 min | Page on-call engineer |
| WARNING | < 1 hour | Notify team channel |
| INFO | Next business day | Log for review |

## Log Retention

- Application logs: 30 days
- Audit logs: 1 year (legal compliance)
- Metrics: 90 days (Prometheus/tsdb retention)
- Recordings: Per exam retention policy (default 90 days)
