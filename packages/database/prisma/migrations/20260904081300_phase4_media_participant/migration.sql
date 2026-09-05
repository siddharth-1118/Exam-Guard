-- CreateEnum
CREATE TYPE "MediaParticipantStatus" AS ENUM ('CONNECTING', 'ACTIVE', 'RECONNECTING', 'DISCONNECTED', 'ENDED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProctoringEventType" ADD VALUE 'MEDIA_SESSION_CREATED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MEDIA_CONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MEDIA_DISCONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MEDIA_RECONNECTING';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MEDIA_RECONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MEDIA_FAILED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'TRACK_PUBLISHED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'TRACK_UNPUBLISHED';

-- CreateTable
CREATE TABLE "MediaParticipant" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PUBLISHER',
    "sfuParticipantId" TEXT,
    "status" "MediaParticipantStatus" NOT NULL DEFAULT 'CONNECTING',
    "reconnects" INTEGER NOT NULL DEFAULT 0,
    "connectedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaParticipant_attemptId_key" ON "MediaParticipant"("attemptId");

-- CreateIndex
CREATE INDEX "MediaParticipant_organizationId_status_idx" ON "MediaParticipant"("organizationId", "status");

-- CreateIndex
CREATE INDEX "MediaParticipant_examId_idx" ON "MediaParticipant"("examId");

-- AddForeignKey
ALTER TABLE "MediaParticipant" ADD CONSTRAINT "MediaParticipant_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaParticipant" ADD CONSTRAINT "MediaParticipant_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaParticipant" ADD CONSTRAINT "MediaParticipant_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaParticipant" ADD CONSTRAINT "MediaParticipant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
