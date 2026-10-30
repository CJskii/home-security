BEGIN;

-- Additive defaults describe historical full-frame requests without inventing orientation.
CREATE TYPE "FacingDirection" AS ENUM ('towards_camera', 'away_from_camera', 'sideways', 'unknown');
CREATE TYPE "AiSnapshotMode" AS ENUM ('full', 'cropped');
ALTER TABLE "AiAnalysis"
  ADD COLUMN "facingDirection" "FacingDirection" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "snapshotMode" "AiSnapshotMode" NOT NULL DEFAULT 'full',
  ADD COLUMN "comparisonId" UUID,
  ADD COLUMN "comparisonMetadata" JSONB;
CREATE INDEX "AiAnalysis_facingDirection_createdAt_id_idx" ON "AiAnalysis"("facingDirection", "createdAt", "id");
CREATE INDEX "AiAnalysis_eventId_promptVersion_snapshotMode_idx" ON "AiAnalysis"("eventId", "promptVersion", "snapshotMode");

CREATE INDEX "AiAnalysis_comparisonId_snapshotMode_idx" ON "AiAnalysis"("comparisonId", "snapshotMode");

COMMIT;
