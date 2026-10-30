-- M1.5: metadata only. No event deletion, schema reset or filesystem cleanup.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
ALTER TABLE "EventSnapshot" DROP CONSTRAINT "EventSnapshot_availability";
ALTER TABLE "EventSnapshot"
  ADD COLUMN "origin" VARCHAR(32) NOT NULL DEFAULT 'NVR_PUSH',
  ADD COLUMN "sha256" VARCHAR(64), ADD COLUMN "bytes" INTEGER,
  ADD COLUMN "width" INTEGER, ADD COLUMN "height" INTEGER,
  ADD COLUMN "status" VARCHAR(32) NOT NULL DEFAULT 'FAILED',
  ADD COLUMN "requestedAt" TIMESTAMPTZ(3), ADD COLUMN "acquiredAt" TIMESTAMPTZ(3);
-- Preserve descriptors from existing real captures before removing archive references.
UPDATE "EventSnapshot" s SET "sha256"=b."sha256", "bytes"=b."bytes", "width"=b."width", "height"=b."height", "status"='RECEIVED'
FROM "SnapshotBlob" b WHERE s."blobId"=b."id";
ALTER TABLE "EventSnapshot" DROP CONSTRAINT "EventSnapshot_blobId_fkey", DROP COLUMN "blobId";
ALTER TABLE "EventSnapshot" ALTER COLUMN "notificationId" DROP NOT NULL,
  ALTER COLUMN "origin" DROP DEFAULT, ALTER COLUMN "status" DROP DEFAULT;
DROP TABLE "SnapshotBlob";
CREATE TABLE "EvidenceProcessing" (
  "eventId" UUID NOT NULL, "status" VARCHAR(32) NOT NULL, "reason" VARCHAR(64),
  "startedAt" TIMESTAMPTZ(3) NOT NULL, "finishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "EvidenceProcessing_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "EvidenceProcessing_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EvidenceProcessing_status" CHECK ("status" IN ('COLLECTING','COMPLETE','SKIPPED','FAILED','INTERRUPTED'))
);
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_origin" CHECK ("origin" IN ('NVR_PUSH','NVR_LIVE'));
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_metadata" CHECK (
  ("status"='RECEIVED' AND "failureCode" IS NULL AND "sha256" ~ '^[a-f0-9]{64}$' AND "bytes">0 AND "bytes"<=32000000 AND "width">0 AND "height">0)
  OR ("status"='FAILED' AND "failureCode" IS NOT NULL AND "sha256" IS NULL AND "bytes" IS NULL AND "width" IS NULL AND "height" IS NULL)
);
-- PostgreSQL CHECK accepts NULL; require populated successful descriptors explicitly.
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_success_fields" CHECK (
  "status"<>'RECEIVED' OR ("sha256" IS NOT NULL AND "bytes" IS NOT NULL AND "width" IS NOT NULL AND "height" IS NOT NULL)
);
ALTER TABLE "EventSnapshot" ADD CONSTRAINT "EventSnapshot_source" CHECK (
  ("origin"='NVR_PUSH' AND "notificationId" IS NOT NULL) OR ("origin"='NVR_LIVE' AND "notificationId" IS NULL)
);
CREATE UNIQUE INDEX "EventSnapshot_live_slot" ON "EventSnapshot"("eventId", "imageOrdinal") WHERE "origin"='NVR_LIVE';
COMMIT;
