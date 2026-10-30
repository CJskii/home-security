BEGIN;

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('OPEN', 'PROVISIONAL', 'CLOSED', 'RETRACTED');

-- CreateEnum
CREATE TYPE "ActivityClassification" AS ENUM ('DETECTION', 'CONTINUITY_CANDIDATE', 'PERSON_VEHICLE_CONTEXT', 'RECURRING_BACKGROUND');

-- CreateEnum
CREATE TYPE "ActivityEvidenceLevel" AS ENUM ('OBSERVED', 'CONTEXTUAL', 'ATTRIBUTE_SUPPORTED');

-- CreateTable
CREATE TABLE "SecurityActivity" (
    "id" UUID NOT NULL,
    "correlationKey" VARCHAR(128) NOT NULL,
    "status" "ActivityStatus" NOT NULL,
    "classification" "ActivityClassification" NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "cameras" TEXT[] NOT NULL,
    "zones" TEXT[] NOT NULL,
    "objectTypes" TEXT[] NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceLevel" "ActivityEvidenceLevel" NOT NULL,
    "algorithmVersion" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "decisionHash" VARCHAR(64) NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SecurityActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceLevel" "ActivityEvidenceLevel" NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityRevision" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "ActivityStatus" NOT NULL,
    "classification" "ActivityClassification" NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceLevel" "ActivityEvidenceLevel" NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "algorithmVersion" VARCHAR(64) NOT NULL,
    "policyHash" VARCHAR(64) NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityCorrelationState" (
    "eventId" UUID NOT NULL,
    "inputHash" VARCHAR(32) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "policyHash" VARCHAR(64) NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ActivityCorrelationState_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecurityActivity_correlationKey_key" ON "SecurityActivity"("correlationKey");

-- CreateIndex
CREATE INDEX "SecurityActivity_createdAt_id_idx" ON "SecurityActivity"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SecurityActivity_startedAt_id_idx" ON "SecurityActivity"("startedAt", "id");

-- CreateIndex
CREATE INDEX "SecurityActivity_endedAt_idx" ON "SecurityActivity"("endedAt");

-- CreateIndex
CREATE INDEX "SecurityActivity_status_classification_startedAt_idx" ON "SecurityActivity"("status", "classification", "startedAt");

-- CreateIndex
CREATE INDEX "SecurityActivity_evidenceLevel_startedAt_idx" ON "SecurityActivity"("evidenceLevel", "startedAt");

-- CreateIndex
CREATE INDEX "SecurityActivity_cameras_idx" ON "SecurityActivity" USING GIN ("cameras");

-- CreateIndex
CREATE INDEX "SecurityActivity_zones_idx" ON "SecurityActivity" USING GIN ("zones");

-- CreateIndex
CREATE INDEX "SecurityActivity_objectTypes_idx" ON "SecurityActivity" USING GIN ("objectTypes");

-- CreateIndex
CREATE INDEX "ActivityEvent_eventId_activityId_idx" ON "ActivityEvent"("eventId", "activityId");

-- CreateIndex
CREATE INDEX "ActivityEvent_reason_createdAt_idx" ON "ActivityEvent"("reason", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_activityId_eventId_key" ON "ActivityEvent"("activityId", "eventId");

-- CreateIndex
CREATE INDEX "ActivityRevision_activityId_createdAt_id_idx" ON "ActivityRevision"("activityId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityRevision_activityId_revision_key" ON "ActivityRevision"("activityId", "revision");

-- CreateIndex
CREATE INDEX "ActivityCorrelationState_needsReview_eventId_idx" ON "ActivityCorrelationState"("needsReview", "eventId");

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "SecurityActivity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRevision" ADD CONSTRAINT "ActivityRevision_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "SecurityActivity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityCorrelationState" ADD CONSTRAINT "ActivityCorrelationState_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Confidence values are fixed evidence scores, not calibrated probabilities.
ALTER TABLE "SecurityActivity" ADD CONSTRAINT "SecurityActivity_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1), ADD CONSTRAINT "SecurityActivity_revision_check" CHECK ("revision" > 0);
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "ActivityRevision" ADD CONSTRAINT "ActivityRevision_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1), ADD CONSTRAINT "ActivityRevision_revision_check" CHECK ("revision" > 0);

COMMIT;
