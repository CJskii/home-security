-- Phase 3: additive reference metadata only. No source/image/hash rewrites or backfill.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
ALTER TABLE "EventSnapshot"
  ADD COLUMN "nvrPictureName" VARCHAR(256),
  ADD COLUMN "nvrPictureSize" INTEGER,
  ADD COLUMN "nvrPictureType" INTEGER,
  ADD COLUMN "nvrRecordId" VARCHAR(256),
  ADD COLUMN "referenceStatus" VARCHAR(32) NOT NULL DEFAULT 'UNRESOLVED',
  ADD COLUMN "referenceResolvedAt" TIMESTAMPTZ(3),
  ADD COLUMN "referenceVerifiedAt" TIMESTAMPTZ(3),
  ADD COLUMN "referenceCheckedAt" TIMESTAMPTZ(3),
  ADD COLUMN "referenceFailureCode" VARCHAR(64),
  ADD COLUMN "referenceProvenance" JSONB,
  ADD COLUMN "referenceVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EventSnapshot"
  ADD CONSTRAINT "EventSnapshot_reference_status" CHECK ("referenceStatus" IN
    ('UNRESOLVED','VERIFIED','TEMPORARILY_UNAVAILABLE','NOT_FOUND','INTEGRITY_MISMATCH')),
  ADD CONSTRAINT "EventSnapshot_reference_version" CHECK ("referenceVersion">=0),
  ADD CONSTRAINT "EventSnapshot_reference_fields" CHECK (
    ("nvrPictureName" IS NULL AND "nvrPictureSize" IS NULL AND "nvrPictureType" IS NULL
      AND "nvrRecordId" IS NULL AND "referenceResolvedAt" IS NULL AND "referenceVerifiedAt" IS NULL
      AND "referenceProvenance" IS NULL)
    OR
    ("nvrPictureName" IS NOT NULL AND length("nvrPictureName")>0
      AND "nvrPictureSize" IS NOT NULL AND "nvrPictureSize">0
      AND "nvrPictureType" IS NOT NULL AND "nvrPictureType" IN (1,2)
      AND "referenceResolvedAt" IS NOT NULL AND "referenceVerifiedAt" IS NOT NULL
      AND "referenceProvenance" IS NOT NULL AND jsonb_typeof("referenceProvenance")='object'
      AND octet_length("referenceProvenance"::text)<=4096
      AND "origin"='NVR_PUSH' AND "status"='RECEIVED' AND "notificationId" IS NOT NULL
      AND "imageType" IS NOT NULL AND "imageType"="nvrPictureType"::text
      AND "sha256" IS NOT NULL AND "sha256" ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT "EventSnapshot_reference_verified" CHECK (
    "referenceStatus"<>'VERIFIED' OR ("nvrPictureName" IS NOT NULL AND "referenceCheckedAt" IS NOT NULL));
COMMIT;
