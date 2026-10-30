BEGIN;

-- Explicit unknown defaults preserve historical analyses without inventing motion.
CREATE TYPE "MovementDirection" AS ENUM ('unknown', 'towards_camera', 'away_from_camera');
CREATE TYPE "PropertyMovement" AS ENUM ('unknown', 'entering_garden', 'leaving_property');
ALTER TABLE "AiAnalysis"
  ADD COLUMN "movementDirection" "MovementDirection" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "propertyMovement" "PropertyMovement" NOT NULL DEFAULT 'unknown';
CREATE INDEX "AiAnalysis_movementDirection_createdAt_id_idx" ON "AiAnalysis"("movementDirection", "createdAt", "id");
CREATE INDEX "AiAnalysis_propertyMovement_createdAt_id_idx" ON "AiAnalysis"("propertyMovement", "createdAt", "id");

COMMIT;
