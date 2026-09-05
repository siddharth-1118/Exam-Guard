-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProctoringEventType" ADD VALUE 'CAMERA_CONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'CAMERA_DISCONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'CAMERA_PERMISSION_GRANTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'CAMERA_PERMISSION_DENIED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'CAMERA_DEVICE_CHANGED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MIC_UNMUTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MIC_PERMISSION_GRANTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MIC_PERMISSION_DENIED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'SCREEN_PERMISSION_GRANTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'SCREEN_PERMISSION_DENIED';

-- AlterTable
ALTER TABLE "ProctoringEvent" ADD COLUMN     "clientEventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProctoringEvent_clientEventId_key" ON "ProctoringEvent"("clientEventId");

