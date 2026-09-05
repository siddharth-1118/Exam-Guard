-- C18: Database Production Hardening
-- Index for retention sweeper: WHERE retentionUntil <= NOW() AND status NOT IN (...)
-- This is the hottest unindexed query path for recordings lifecycle.
CREATE INDEX IF NOT EXISTS "Recording_retentionUntil_idx" ON "Recording" ("retentionUntil");

-- Index for audit log resource-based lookups (admin queries, incident investigations).
-- Covers the pattern: SELECT * FROM AuditLog WHERE resourceType = ? AND resourceId = ? ORDER BY createdAt
CREATE INDEX IF NOT EXISTS "AuditLog_resourceType_resourceId_idx" ON "AuditLog" ("resourceType", "resourceId");
