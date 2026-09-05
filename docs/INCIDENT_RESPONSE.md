# ExamGuard Incident Response Guide (C52)

## Incident Classification

| Severity | Description | Response Time |
|---|---|---|
| P1 Critical | Service completely unavailable | < 15 min |
| P2 High | Major feature degraded | < 1 hour |
| P3 Medium | Minor feature affected | < 4 hours |
| P4 Low | Cosmetic or non-urgent | Next business day |

## Common Incidents

### Service Outage

1. Check `/health` and `/ready` endpoints
2. Review application logs
3. Check database connectivity
4. Check Redis connectivity
5. Restart affected service
6. Monitor recovery

### Database Failure

1. Verify PostgreSQL is running
2. Check connection pool exhaustion
3. Review slow queries
4. If data corruption: restore from backup
5. Run `npx prisma migrate status` to verify schema

### Redis Failure

1. Redis is ephemeral — failure degrades but doesn't break
2. Restart Redis
3. Verify presence re-syncs via heartbeat
4. Monitor for stale participant cleanup

### SFU Failure

1. Restart media service
2. Students will reconnect automatically (45s grace)
3. Monitor reconnection success rate
4. Verify recording egress recovers

### Recording Failure

1. Check FFmpeg process status
2. Verify storage availability (disk space / S3)
3. Review recording failure logs
4. Failed recordings are explicitly marked (never false READY)

### Suspected Cheating

1. Review proctoring events for the attempt
2. Check AI events (if model is active)
3. Monitor can flag, message, or terminate
4. All actions are audited
5. Preserve evidence (recordings, events)

### Data Breach

1. Contain the breach (revoke compromised credentials)
2. Assess scope (which tenants affected)
3. Notify affected organizations
4. Preserve audit logs
5. Document timeline
6. Review access controls

### Credential Compromise

1. Force logout: increment `tokenVersion` for affected user
2. Reset password
3. Review audit logs for unauthorized access
4. Check for privilege escalation
5. Notify affected user
