-- Additive scoring ledger. No historical rows are inserted or modified.
BEGIN;
-- CreateEnum
CREATE TYPE "EvidenceScoreDomain" AS ENUM ('MODEL_REPORTED', 'VISUAL_QUALITY', 'RELATIONSHIP_SUPPORT');

-- CreateEnum
CREATE TYPE "EvidenceScoreState" AS ENUM ('NOT_SCORED', 'INSUFFICIENT_EVIDENCE', 'SCORED');

-- CreateTable
CREATE TABLE "VisualEvidenceScore" (
    "id" UUID NOT NULL,
    "analysisId" UUID NOT NULL,
    "personId" UUID,
    "vehicleId" UUID,
    "observationKey" VARCHAR(32) NOT NULL,
    "attribute" VARCHAR(32) NOT NULL,
    "domain" "EvidenceScoreDomain" NOT NULL,
    "state" "EvidenceScoreState" NOT NULL,
    "score" SMALLINT,
    "reportedBand" VARCHAR(16),
    "reportedBasis" VARCHAR(16),
    "methodVersion" VARCHAR(64) NOT NULL,
    "inputHash" VARCHAR(64) NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualEvidenceScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisualEvidenceScore_filter_idx" ON "VisualEvidenceScore"("domain", "attribute", "methodVersion", "state", "score");

-- CreateIndex
CREATE INDEX "VisualEvidenceScore_analysisId_createdAt_id_idx" ON "VisualEvidenceScore"("analysisId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "VisualEvidenceScore_personId_attribute_score_idx" ON "VisualEvidenceScore"("personId", "attribute", "score");

-- CreateIndex
CREATE INDEX "VisualEvidenceScore_vehicleId_attribute_score_idx" ON "VisualEvidenceScore"("vehicleId", "attribute", "score");

-- CreateIndex
CREATE INDEX "VisualEvidenceScore_createdAt_id_idx" ON "VisualEvidenceScore"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VisualEvidenceScore_assessment_key" ON "VisualEvidenceScore"("analysisId", "observationKey", "attribute", "domain", "methodVersion");

-- CreateIndex
CREATE UNIQUE INDEX "AiPersonObservation_id_analysisId_key" ON "AiPersonObservation"("id", "analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "AiVehicleObservation_id_analysisId_key" ON "AiVehicleObservation"("id", "analysisId");

-- AddForeignKey
ALTER TABLE "VisualEvidenceScore" ADD CONSTRAINT "VisualEvidenceScore_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "AiAnalysis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualEvidenceScore" ADD CONSTRAINT "VisualEvidenceScore_personId_analysisId_fkey" FOREIGN KEY ("personId", "analysisId") REFERENCES "AiPersonObservation"("id", "analysisId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualEvidenceScore" ADD CONSTRAINT "VisualEvidenceScore_vehicleId_analysisId_fkey" FOREIGN KEY ("vehicleId", "analysisId") REFERENCES "AiVehicleObservation"("id", "analysisId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Prisma cannot express these CHECKs or append-only triggers; keep them versioned.
ALTER TABLE "VisualEvidenceScore"
  ADD CONSTRAINT "VisualEvidenceScore_scope_check" CHECK (
    ("personId" IS NULL AND "vehicleId" IS NULL AND "observationKey" = 'analysis' AND "attribute" = 'overallQuality') OR
    ("personId" IS NOT NULL AND "vehicleId" IS NULL AND "observationKey" ~ '^person:[0-9]+$' AND "attribute" IN ('upperClothing','lowerClothing','upperColor','lowerColor','outerwear','headwear','bags','accessories','carriedObjects','visibleActions','facingDirection','visibility')) OR
    ("personId" IS NULL AND "vehicleId" IS NOT NULL AND "observationKey" ~ '^vehicle:[0-9]+$' AND "attribute" IN ('vehicleType','color','make','model','doorState','visibleOccupantCount','motionEvidence','visibility'))
  ),
  ADD CONSTRAINT "VisualEvidenceScore_value_check" CHECK (
    (("state" = 'SCORED' AND "score" IS NOT NULL) OR ("state" <> 'SCORED' AND "score" IS NULL)) AND
    ("score" IS NULL OR "score" BETWEEN 0 AND 100) AND
    ("methodVersion" <> 'visual-quality-v1' OR "score" IS NULL OR "score" IN (25,50,75))
  ),
  ADD CONSTRAINT "VisualEvidenceScore_domain_check" CHECK (
    "domain" <> 'RELATIONSHIP_SUPPORT' AND
    ("domain" <> 'MODEL_REPORTED' OR ("state" = 'NOT_SCORED' AND "score" IS NULL)) AND
    ("attribute" <> 'overallQuality' OR "domain" = 'VISUAL_QUALITY')
  ),
  ADD CONSTRAINT "VisualEvidenceScore_report_check" CHECK (
    ("reportedBand" IS NULL OR "reportedBand" IN ('high','medium','low','unknown')) AND
    ("reportedBasis" IS NULL OR "reportedBasis" IN ('direct_visual','interpretation','unknown'))
  ),
  ADD CONSTRAINT "VisualEvidenceScore_evidence_check" CHECK (
    "inputHash" ~ '^[a-f0-9]{64}$' AND octet_length("evidence"::text) <= 2048 AND
    jsonb_typeof("evidence") = 'object' AND
    COALESCE(jsonb_typeof("evidence"->'input') = 'object', false) AND
    COALESCE(jsonb_typeof("evidence"->'reasons') = 'array', false) AND
    CASE WHEN jsonb_typeof("evidence"->'reasons') = 'array' THEN jsonb_array_length("evidence"->'reasons') BETWEEN 1 AND 8 ELSE false END
  );

CREATE FUNCTION reject_visual_evidence_score_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'VisualEvidenceScore is append-only';
END;
$$;
CREATE TRIGGER "VisualEvidenceScore_append_only"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "VisualEvidenceScore"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_visual_evidence_score_mutation();
COMMIT;
