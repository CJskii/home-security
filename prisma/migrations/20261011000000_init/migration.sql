-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL,
    "frigateTrackingId" VARCHAR(128) NOT NULL,
    "camera" VARCHAR(128) NOT NULL,
    "zone" VARCHAR(128) NOT NULL DEFAULT '',
    "label" VARCHAR(128),
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "sourceUpdatedAt" TIMESTAMPTZ(3),
    "selectedPayload" JSONB NOT NULL DEFAULT '{}',
    "snapshotRef" TEXT,
    "clipRef" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAnalysis" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "status" "AiJobStatus" NOT NULL DEFAULT 'PENDING',
    "model" VARCHAR(128),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "jobMetadata" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAction" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "type" VARCHAR(128) NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "notificationPayload" JSONB NOT NULL DEFAULT '{}',
    "deliveryMetadata" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SecurityAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_updatedAt_idx" ON "SecurityEvent"("updatedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_startedAt_idx" ON "SecurityEvent"("startedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_endedAt_idx" ON "SecurityEvent"("endedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_camera_startedAt_idx" ON "SecurityEvent"("camera", "startedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_zone_startedAt_idx" ON "SecurityEvent"("zone", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityEvent_frigateTrackingId_camera_zone_key" ON "SecurityEvent"("frigateTrackingId", "camera", "zone");

-- CreateIndex
CREATE UNIQUE INDEX "AiAnalysis_idempotencyKey_key" ON "AiAnalysis"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AiAnalysis_eventId_createdAt_idx" ON "AiAnalysis"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_status_nextAttemptAt_idx" ON "AiAnalysis"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_createdAt_idx" ON "AiAnalysis"("createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_updatedAt_idx" ON "AiAnalysis"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityAction_idempotencyKey_key" ON "SecurityAction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SecurityAction_eventId_createdAt_idx" ON "SecurityAction"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAction_status_nextAttemptAt_idx" ON "SecurityAction"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SecurityAction_createdAt_idx" ON "SecurityAction"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityAction_updatedAt_idx" ON "SecurityAction"("updatedAt");

-- AddForeignKey
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityAction" ADD CONSTRAINT "SecurityAction_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
