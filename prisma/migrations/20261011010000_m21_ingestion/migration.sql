-- CreateEnum
CREATE TYPE "EventProcessingStatus" AS ENUM ('UNPROCESSED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- AlterTable
ALTER TABLE "SecurityEvent" ADD COLUMN     "processingStatus" "EventProcessingStatus" NOT NULL DEFAULT 'UNPROCESSED';

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_id_idx" ON "SecurityEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SecurityEvent_label_startedAt_idx" ON "SecurityEvent"("label", "startedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_processingStatus_startedAt_idx" ON "SecurityEvent"("processingStatus", "startedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_camera_createdAt_id_idx" ON "SecurityEvent"("camera", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SecurityEvent_zone_createdAt_id_idx" ON "SecurityEvent"("zone", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SecurityEvent_label_createdAt_id_idx" ON "SecurityEvent"("label", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SecurityEvent_processingStatus_createdAt_id_idx" ON "SecurityEvent"("processingStatus", "createdAt", "id");
