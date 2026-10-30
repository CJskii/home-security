-- M3.4: additive, preserves all earlier analyses and observations.
BEGIN;

-- AlterTable
ALTER TABLE "AiAnalysis" ADD COLUMN     "imageColourMode" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "lightingQuality" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "snapshotTimeSource" VARCHAR(32) NOT NULL DEFAULT 'unknown';

-- AlterTable
ALTER TABLE "AiPersonObservation" ADD COLUMN     "accessories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "attributeEvidence" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "attribution" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "bags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "facingDirection" "FacingDirection" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "headwear" VARCHAR(32),
ADD COLUMN     "limitations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lowerColor" VARCHAR(32),
ADD COLUMN     "outerwear" VARCHAR(32),
ADD COLUMN     "upperColor" VARCHAR(32),
ADD COLUMN     "visibility" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "visibleActions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "AiVehicleObservation" ADD COLUMN     "attributeEvidence" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "attribution" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "doorState" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "limitations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "makeModelConfidence" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "motionEvidence" VARCHAR(32) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "visibility" VARCHAR(16) NOT NULL DEFAULT 'unknown',
ADD COLUMN     "visibleOccupantCount" INTEGER;

-- CreateIndex
CREATE INDEX "AiPersonObservation_upperColor_upperClothing_idx" ON "AiPersonObservation"("upperColor", "upperClothing");

-- CreateIndex
CREATE INDEX "AiPersonObservation_lowerColor_lowerClothing_idx" ON "AiPersonObservation"("lowerColor", "lowerClothing");

-- CreateIndex
CREATE INDEX "AiPersonObservation_outerwear_idx" ON "AiPersonObservation"("outerwear");

-- CreateIndex
CREATE INDEX "AiPersonObservation_headwear_idx" ON "AiPersonObservation"("headwear");

-- CreateIndex
CREATE INDEX "AiPersonObservation_bags_idx" ON "AiPersonObservation" USING GIN ("bags");

-- CreateIndex
CREATE INDEX "AiPersonObservation_accessories_idx" ON "AiPersonObservation" USING GIN ("accessories");

-- CreateIndex
CREATE INDEX "AiPersonObservation_visibleActions_idx" ON "AiPersonObservation" USING GIN ("visibleActions");

-- CreateIndex
CREATE INDEX "AiPersonObservation_facingDirection_idx" ON "AiPersonObservation"("facingDirection");

-- CreateIndex
CREATE INDEX "AiVehicleObservation_doorState_idx" ON "AiVehicleObservation"("doorState");

-- CreateIndex
CREATE INDEX "AiVehicleObservation_visibleOccupantCount_idx" ON "AiVehicleObservation"("visibleOccupantCount");

COMMIT;
