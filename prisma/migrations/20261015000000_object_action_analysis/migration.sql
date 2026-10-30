-- Action-focused, per-object AI enrichment only; no source facts or media rewritten.
BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SET LOCAL search_path=public,pg_catalog;
DO $$ BEGIN IF current_database()<>'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
ALTER TABLE "EvidenceProcessing" ADD COLUMN "analysisAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "analysisRetries" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "analysisStartedAt" TIMESTAMPTZ(3), ADD CONSTRAINT "EvidenceProcessing_analysis_attempts" CHECK ("analysisAttempts">=0 AND "analysisRetries">=0);
ALTER TABLE "EventAnalysis" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
 ADD CONSTRAINT "EventAnalysis_revision" CHECK ("revision">0);
ALTER TABLE "EventAnalysis" DROP CONSTRAINT "EventAnalysis_json_bounds";
ALTER TABLE "EventAnalysis" ADD CONSTRAINT "EventAnalysis_json_bounds" CHECK (
 jsonb_typeof("subjects")='array' AND jsonb_array_length("subjects")<=6 AND
 jsonb_typeof("uncertainties")='array' AND jsonb_array_length("uncertainties")<=8 AND
 jsonb_typeof("evidence")='array' AND jsonb_array_length("evidence") BETWEEN 1 AND 6);
CREATE UNIQUE INDEX "UniviewObject_eventId_id_key" ON "UniviewObject"("eventId","id");
CREATE TABLE "ObjectAnalysis" (
 "objectId" UUID PRIMARY KEY, "eventId" UUID NOT NULL,
 "observedType" VARCHAR(32) NOT NULL, "verification" VARCHAR(16) NOT NULL,
 "actions" JSONB NOT NULL, "continuity" VARCHAR(16) NOT NULL, "evidenceImages" JSONB NOT NULL,
 "shortDescription" VARCHAR(512) NOT NULL, "detailedDescription" VARCHAR(4096),
 "movementDirection" VARCHAR(128), "uncertainties" JSONB NOT NULL,
 CONSTRAINT "ObjectAnalysis_analysis_fkey" FOREIGN KEY ("eventId") REFERENCES "EventAnalysis"("eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ObjectAnalysis_object_fkey" FOREIGN KEY ("eventId","objectId") REFERENCES "UniviewObject"("eventId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ObjectAnalysis_verification" CHECK ("verification" IN ('supported','uncertain','contradicted')),
 CONSTRAINT "ObjectAnalysis_type" CHECK ("observedType" IN ('person','motor_vehicle','non_motor_vehicle','animal','unknown')),
 CONSTRAINT "ObjectAnalysis_continuity" CHECK ("continuity" IN ('supported','uncertain')),
 CONSTRAINT "ObjectAnalysis_bounds" CHECK (jsonb_typeof("actions")='array' AND jsonb_array_length("actions") BETWEEN 1 AND 6
 AND jsonb_typeof("evidenceImages")='array' AND jsonb_array_length("evidenceImages") BETWEEN 1 AND 6
 AND jsonb_typeof("uncertainties")='array' AND jsonb_array_length("uncertainties")<=8)
);
CREATE UNIQUE INDEX "ObjectAnalysis_eventId_objectId_key" ON "ObjectAnalysis"("eventId","objectId");
CREATE INDEX "ObjectAnalysis_verification_observedType_idx" ON "ObjectAnalysis"("verification","observedType");
COMMIT;
