-- DESTRUCTIVE: disposable Home Security application data only.
-- Requires separate reviewed SQL approval and read-only consumer/dependency preflight.
-- Never run automatically at application startup. No CASCADE, schema/volume/container reset.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
  IF current_database() <> 'security_events' THEN
    RAISE EXCEPTION 'Wrong application database';
  END IF;
END $$;

DROP TABLE public."SecurityEvent", public."AiAnalysis", public."SecurityAction", public."EventZoneTransition", public."AiPersonObservation", public."AiVehicleObservation", public."SecurityActivity", public."ActivityEvent", public."ActivityRevision", public."ActivityCorrelationState", public."VisualEvidenceScore";

-- The table drop removes the append-only trigger, but not its helper function.
DROP FUNCTION public.reject_visual_evidence_score_mutation();

DROP TYPE public."AiJobStatus";
DROP TYPE public."MovementDirection";
DROP TYPE public."PropertyMovement";
DROP TYPE public."ActionStatus";
DROP TYPE public."EventProcessingStatus";
DROP TYPE public."FacingDirection";
DROP TYPE public."AiSnapshotMode";
DROP TYPE public."ActivityStatus";
DROP TYPE public."ActivityClassification";
DROP TYPE public."ActivityEvidenceLevel";
DROP TYPE public."EvidenceScoreDomain";
DROP TYPE public."EvidenceScoreState";

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('ALARM', 'STRUCTURE');

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL,
    "sourceInstallationId" UUID NOT NULL,
    "nvrChannel" INTEGER NOT NULL,
    "alarmType" VARCHAR(100) NOT NULL,
    "relatedId" VARCHAR(256) NOT NULL,
    "camera" VARCHAR(128),
    "alarmSeen" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMPTZ(3),
    "sourceUpdatedAt" TIMESTAMPTZ(3),
    "nativeEndedAt" TIMESTAMPTZ(3),
    "firstReceivedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastReceivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniviewNotification" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "reportedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "personCount" INTEGER,
    "vehicleCount" INTEGER,
    "objectType" VARCHAR(100),
    "metadata" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "UniviewNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotBlob" (
    "id" UUID NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "storageKey" VARCHAR(128) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SnapshotBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSnapshot" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "blobId" UUID,
    "imageOrdinal" INTEGER NOT NULL,
    "sourceImageIndex" INTEGER,
    "imageType" VARCHAR(100),
    "declaredWidth" INTEGER,
    "declaredHeight" INTEGER,
    "capturedAt" TIMESTAMPTZ(3),
    "failureCode" VARCHAR(32),

    CONSTRAINT "EventSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrigateObservation" (
    "id" UUID NOT NULL,
    "sourceInstanceId" UUID NOT NULL,
    "trackingId" VARCHAR(128) NOT NULL,
    "camera" VARCHAR(128) NOT NULL,
    "label" VARCHAR(128) NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "sourceUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FrigateObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_id_idx" ON "SecurityEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SecurityEvent_camera_occurredAt_idx" ON "SecurityEvent"("camera", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityEvent_sourceInstallationId_nvrChannel_alarmType_rel_key" ON "SecurityEvent"("sourceInstallationId", "nvrChannel", "alarmType", "relatedId");

-- CreateIndex
CREATE INDEX "UniviewNotification_eventId_receivedAt_id_idx" ON "UniviewNotification"("eventId", "receivedAt", "id");

-- CreateIndex
CREATE INDEX "UniviewNotification_objectType_reportedAt_idx" ON "UniviewNotification"("objectType", "reportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UniviewNotification_eventId_kind_contentHash_key" ON "UniviewNotification"("eventId", "kind", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "UniviewNotification_eventId_id_key" ON "UniviewNotification"("eventId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotBlob_sha256_key" ON "SnapshotBlob"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotBlob_storageKey_key" ON "SnapshotBlob"("storageKey");

-- CreateIndex
CREATE INDEX "EventSnapshot_eventId_capturedAt_idx" ON "EventSnapshot"("eventId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventSnapshot_notificationId_imageOrdinal_key" ON "EventSnapshot"("notificationId", "imageOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "EventSnapshot_eventId_id_key" ON "EventSnapshot"("eventId", "id");

-- CreateIndex
CREATE INDEX "FrigateObservation_camera_startedAt_idx" ON "FrigateObservation"("camera", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FrigateObservation_sourceInstanceId_trackingId_camera_key" ON "FrigateObservation"("sourceInstanceId", "trackingId", "camera");

-- AddForeignKey
ALTER TABLE "UniviewNotification" ADD CONSTRAINT "UniviewNotification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_eventId_notificationId_fkey" FOREIGN KEY ("eventId", "notificationId") REFERENCES "UniviewNotification"("eventId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "SnapshotBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Capture integrity checks beyond Prisma's declarative schema.
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_channel_positive" CHECK ("nvrChannel" > 0);
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_receipt_order" CHECK ("lastReceivedAt" >= "firstReceivedAt");
ALTER TABLE "SnapshotBlob" ADD CONSTRAINT "SnapshotBlob_integrity" CHECK ("bytes" > 0 AND "bytes" <= 32000000 AND "width" > 0 AND "height" > 0 AND "sha256" ~ '^[a-f0-9]{64}$' AND "storageKey" = left("sha256", 2) || '/' || "sha256" || '.jpg');
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_availability" CHECK (("blobId" IS NOT NULL AND "failureCode" IS NULL) OR ("blobId" IS NULL AND "failureCode" IS NOT NULL AND "failureCode" IN ('invalid_image', 'image_unavailable')));
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_ordinal" CHECK ("imageOrdinal" >= 0);
ALTER TABLE "UniviewNotification" ADD CONSTRAINT "UniviewNotification_counts" CHECK (("personCount" IS NULL OR "personCount" >= 0) AND ("vehicleCount" IS NULL OR "vehicleCount" >= 0));
COMMIT;
