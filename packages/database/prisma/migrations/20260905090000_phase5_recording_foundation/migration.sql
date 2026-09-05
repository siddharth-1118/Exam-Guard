-- Phase 4B publisher event enum values were applied to the live dev database
-- out-of-band (without a recorded migration). They are recorded here so a fresh
-- database replaying migrations from scratch reaches the same final schema.
-- IF NOT EXISTS keeps replay safe: the earlier phase4b migration already adds
-- the same values on a fresh database.
ALTER TYPE "ProctoringEventType" ADD VALUE IF NOT EXISTS 'MEDIA_PUBLISHER_CONNECTING';
ALTER TYPE "ProctoringEventType" ADD VALUE IF NOT EXISTS 'MEDIA_PUBLISHER_CONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE IF NOT EXISTS 'MEDIA_PUBLISHER_RECONNECTING';
ALTER TYPE "ProctoringEventType" ADD VALUE IF NOT EXISTS 'MEDIA_PUBLISHER_RECONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE IF NOT EXISTS 'MEDIA_PUBLISHER_DISCONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE IF NOT EXISTS 'MEDIA_PUBLISHER_FAILED';

-- ---------------------------------------------------------------------------
-- Phase 5 — Recording & Evidence Foundation
-- ---------------------------------------------------------------------------

-- RecordingKind: 'AUDIO' renamed to 'MICROPHONE' (no rows exist yet), plus a
-- 'COMBINED' kind for future muxed egress.
ALTER TYPE "RecordingKind" RENAME VALUE 'AUDIO' TO 'MICROPHONE';
ALTER TYPE "RecordingKind" ADD VALUE 'COMBINED';

-- Explicit recording state machine: PENDING -> RECORDING -> FINALIZING -> READY,
-- failure to FAILED from PENDING/RECORDING/FINALIZING, READY/FAILED -> DELETED.
CREATE TYPE "RecordingStatus" AS ENUM ('PENDING', 'RECORDING', 'FINALIZING', 'READY', 'FAILED', 'DELETED');

ALTER TABLE "Recording" DROP COLUMN "storageRef";
ALTER TABLE "Recording" ADD COLUMN "organizationId" TEXT NOT NULL;
ALTER TABLE "Recording" ADD COLUMN "examId" TEXT NOT NULL;
ALTER TABLE "Recording" ADD COLUMN "participantId" TEXT;
ALTER TABLE "Recording" ADD COLUMN "storageKey" TEXT NOT NULL;
ALTER TABLE "Recording" ADD COLUMN "sizeBytes" BIGINT;
ALTER TABLE "Recording" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "Recording" ADD COLUMN "checksumSha256" TEXT;
ALTER TABLE "Recording" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Recording" ADD COLUMN "endedAt" TIMESTAMP(3);
ALTER TABLE "Recording" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "Recording" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Recording" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Recording" ALTER COLUMN "status" SET DATA TYPE "RecordingStatus" USING "status"::"RecordingStatus";
ALTER TABLE "Recording" ALTER COLUMN "status" SET DEFAULT 'PENDING';

CREATE INDEX "Recording_organizationId_status_idx" ON "Recording"("organizationId", "status");
CREATE INDEX "Recording_examId_status_idx" ON "Recording"("examId", "status");

ALTER TABLE "Recording" ADD CONSTRAINT "Recording_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;