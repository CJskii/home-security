-- M3.1 additive, explicit deployment migration. Existing analyses remain intact.
BEGIN;

-- AlterTable
ALTER TABLE "AiAnalysis" ADD COLUMN     "activityTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "activityType" VARCHAR(32),
ADD COLUMN     "detailedDescription" TEXT,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "failureCode" VARCHAR(64),
ADD COLUMN     "leaseExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "leaseToken" UUID,
ADD COLUMN     "promptVersion" VARCHAR(64),
ADD COLUMN     "schemaVersion" INTEGER,
ADD COLUMN     "shortDescription" VARCHAR(512),
ADD COLUMN     "snapshotFetchedAt" TIMESTAMPTZ(3),
ADD COLUMN     "snapshotFrameTime" TIMESTAMPTZ(3),
ADD COLUMN     "snapshotSha256" VARCHAR(64),
ADD COLUMN     "supplementary" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "uncertainties" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visiblePersonCount" INTEGER,
ADD COLUMN     "visibleVehicleCount" INTEGER;

-- CreateTable
CREATE TABLE "AiPersonObservation" (
    "id" UUID NOT NULL,
    "analysisId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "upperClothing" VARCHAR(128),
    "lowerClothing" VARCHAR(128),
    "clothingColors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "carriedObjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "supplementary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AiPersonObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVehicleObservation" (
    "id" UUID NOT NULL,
    "analysisId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "vehicleType" VARCHAR(64),
    "color" VARCHAR(64),
    "make" VARCHAR(64),
    "model" VARCHAR(64),
    "supplementary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AiVehicleObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiPersonObservation_clothingColors_idx" ON "AiPersonObservation" USING GIN ("clothingColors");

-- CreateIndex
CREATE INDEX "AiPersonObservation_carriedObjects_idx" ON "AiPersonObservation" USING GIN ("carriedObjects");

-- CreateIndex
CREATE UNIQUE INDEX "AiPersonObservation_analysisId_ordinal_key" ON "AiPersonObservation"("analysisId", "ordinal");

-- CreateIndex
CREATE INDEX "AiVehicleObservation_color_vehicleType_idx" ON "AiVehicleObservation"("color", "vehicleType");

-- CreateIndex
CREATE INDEX "AiVehicleObservation_make_model_idx" ON "AiVehicleObservation"("make", "model");

-- CreateIndex
CREATE UNIQUE INDEX "AiVehicleObservation_analysisId_ordinal_key" ON "AiVehicleObservation"("analysisId", "ordinal");

-- CreateIndex
CREATE INDEX "AiAnalysis_status_leaseExpiresAt_idx" ON "AiAnalysis"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_model_promptVersion_status_nextAttemptAt_idx" ON "AiAnalysis"("model", "promptVersion", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_createdAt_id_idx" ON "AiAnalysis"("createdAt", "id");

-- CreateIndex
CREATE INDEX "AiAnalysis_activityType_createdAt_id_idx" ON "AiAnalysis"("activityType", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AiAnalysis_visiblePersonCount_createdAt_idx" ON "AiAnalysis"("visiblePersonCount", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_visibleVehicleCount_createdAt_idx" ON "AiAnalysis"("visibleVehicleCount", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_activityTags_idx" ON "AiAnalysis" USING GIN ("activityTags");

-- AddForeignKey
ALTER TABLE "AiPersonObservation" ADD CONSTRAINT "AiPersonObservation_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "AiAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVehicleObservation" ADD CONSTRAINT "AiVehicleObservation_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "AiAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable legacy attributes remain unknown rather than fabricated zeroes.
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_counts_duration_check" CHECK (
  ("visiblePersonCount" IS NULL OR "visiblePersonCount" BETWEEN 0 AND 100) AND
  ("visibleVehicleCount" IS NULL OR "visibleVehicleCount" BETWEEN 0 AND 100) AND
  ("durationMs" IS NULL OR "durationMs" >= 0)
);
ALTER TABLE "AiPersonObservation" ADD CONSTRAINT "AiPersonObservation_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 15);
ALTER TABLE "AiVehicleObservation" ADD CONSTRAINT "AiVehicleObservation_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 15);
COMMIT;
