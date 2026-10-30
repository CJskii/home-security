-- Operator-applied; never applied on application startup. No row updates/deletes.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
ALTER TABLE "UniviewZoneVersion" DROP CONSTRAINT "UniviewZoneVersion_polygon";
ALTER TABLE "UniviewZoneVersion" ADD CONSTRAINT "UniviewZoneVersion_polygon"
  CHECK (jsonb_typeof("polygon")='array' AND (jsonb_array_length("polygon")=0 OR jsonb_array_length("polygon") BETWEEN 3 AND 16));
ALTER TABLE "UniviewZoneVersion" ADD COLUMN "configuration" JSONB;
CREATE TABLE "CameraConfiguration" (
  "sourceInstallationId" UUID NOT NULL,
  "channel" INTEGER NOT NULL CHECK ("channel" BETWEEN 1 AND 2),
  "snapshot" JSONB,
  "lastSuccessfulAt" TIMESTAMPTZ(3),
  "lastAttemptAt" TIMESTAMPTZ(3) NOT NULL,
  "failed" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "CameraConfiguration_pkey" PRIMARY KEY ("sourceInstallationId", "channel")
);
COMMIT;
