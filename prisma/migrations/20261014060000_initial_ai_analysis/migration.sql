-- M3: one initial interpretation per canonical UUID; no image or raw model-response columns.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
ALTER TABLE "EvidenceProcessing" DROP CONSTRAINT "EvidenceProcessing_status";
ALTER TABLE "EvidenceProcessing" ADD CONSTRAINT "EvidenceProcessing_status" CHECK ("status" IN ('COLLECTING','ANALYSING','COMPLETE','SKIPPED','FAILED','INTERRUPTED'));
CREATE TABLE "EventAnalysis" (
  "eventId" UUID NOT NULL,
  "inputFingerprint" VARCHAR(64) NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "promptVersion" INTEGER NOT NULL, "schemaVersion" INTEGER NOT NULL,
  "activityLabel" VARCHAR(64) NOT NULL,
  "shortDescription" VARCHAR(512) NOT NULL,
  "detailedDescription" VARCHAR(4096) NOT NULL,
  "subjects" JSONB NOT NULL, "movementDirection" VARCHAR(128),
  "uncertainties" JSONB NOT NULL, "evidence" JSONB NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "EventAnalysis_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "EventAnalysis_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EventAnalysis_fingerprint" CHECK ("inputFingerprint" ~ '^[a-f0-9]{64}$' AND "promptVersion">0 AND "schemaVersion">0),
  CONSTRAINT "EventAnalysis_activity" CHECK ("activityLabel" IN ('passing_by','approaching','leaving','standing','interacting_with_vehicle','carrying_object','unknown')),
  CONSTRAINT "EventAnalysis_json_bounds" CHECK (jsonb_typeof("subjects")='array' AND jsonb_array_length("subjects")<=6 AND jsonb_typeof("uncertainties")='array' AND jsonb_array_length("uncertainties")<=8 AND jsonb_typeof("evidence")='array' AND jsonb_array_length("evidence") BETWEEN 1 AND 3)
);
CREATE INDEX "EventAnalysis_activityLabel_completedAt_idx" ON "EventAnalysis"("activityLabel", "completedAt");
COMMIT;
