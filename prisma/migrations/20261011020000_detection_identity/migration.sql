-- Explicit release migration only; never run on application startup.
-- Stop API writers and take a verified backup before applying this migration.
BEGIN;
LOCK TABLE "SecurityEvent", "AiAnalysis", "SecurityAction" IN ACCESS EXCLUSIVE MODE;

-- DropIndex
DROP INDEX "SecurityEvent_zone_createdAt_id_idx";

-- DropIndex
DROP INDEX "SecurityEvent_zone_startedAt_idx";

-- DropIndex
DROP INDEX "SecurityEvent_frigateTrackingId_camera_zone_key";

-- AlterTable
ALTER TABLE "SecurityEvent" ADD COLUMN     "primaryZone" VARCHAR(128),
ADD COLUMN     "primaryZoneObservedAt" TIMESTAMPTZ(3),
ADD COLUMN     "observedZoneCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentZones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "enteredZones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "legacyRecords" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "metadataUpdatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "observedZones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "zoneUpdatedAt" TIMESTAMPTZ(3);

-- Consolidate deployed per-zone rows without losing their original metadata.
-- No source arrays/transitions can be reconstructed from the old selected payload.
CREATE TEMP TABLE detection_merge ON COMMIT DROP AS
SELECT "id" AS old_id,
       first_value("id") OVER (
         PARTITION BY "frigateTrackingId", "camera" ORDER BY "createdAt", "id"
       ) AS keep_id
FROM "SecurityEvent";

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "SecurityEvent" GROUP BY "frigateTrackingId", "camera"
    HAVING count(DISTINCT "label") > 1
  ) THEN RAISE EXCEPTION 'Conflicting labels for detection identity; operator review required';
  END IF;
END;
$$;

WITH grouped AS (
  SELECT m.keep_id,
         min(e."startedAt") AS started_at, max(e."endedAt") AS ended_at,
         max(e."sourceUpdatedAt") AS source_updated_at, max(e."updatedAt") AS updated_at,
         jsonb_agg(to_jsonb(e) - ARRAY['currentZones', 'enteredZones', 'observedZones',
           'zoneUpdatedAt', 'metadataUpdatedAt', 'legacyRecords', 'primaryZone',
           'primaryZoneObservedAt', 'observedZoneCount'] ORDER BY e."createdAt", e."id") AS legacy,
         array_agg(DISTINCT e."zone") FILTER (WHERE e."zone" <> '') AS zones
  FROM "SecurityEvent" e JOIN detection_merge m ON m.old_id = e."id"
  GROUP BY m.keep_id
), selected AS (
  SELECT DISTINCT ON (m.keep_id) m.keep_id, e."selectedPayload", e."sourceUpdatedAt"
  FROM "SecurityEvent" e JOIN detection_merge m ON m.old_id = e."id"
  ORDER BY m.keep_id, (e."endedAt" IS NOT NULL) DESC,
    e."sourceUpdatedAt" DESC NULLS LAST, e."id" DESC
)
UPDATE "SecurityEvent" e SET
  "startedAt" = g.started_at, "endedAt" = g.ended_at,
  "sourceUpdatedAt" = g.source_updated_at, "updatedAt" = g.updated_at,
  "selectedPayload" = s."selectedPayload", "metadataUpdatedAt" = s."sourceUpdatedAt",
  "observedZones" = coalesce(g.zones, ARRAY[]::TEXT[]),
  "observedZoneCount" = coalesce(cardinality(g.zones), 0), "legacyRecords" = g.legacy
FROM grouped g JOIN selected s ON s.keep_id = g.keep_id WHERE e."id" = g.keep_id;

UPDATE "AiAnalysis" a SET "eventId" = m.keep_id
FROM detection_merge m WHERE a."eventId" = m.old_id AND m.old_id <> m.keep_id;
UPDATE "SecurityAction" a SET "eventId" = m.keep_id
FROM detection_merge m WHERE a."eventId" = m.old_id AND m.old_id <> m.keep_id;
DELETE FROM "SecurityEvent" e USING detection_merge m
WHERE e."id" = m.old_id AND m.old_id <> m.keep_id;
ALTER TABLE "SecurityEvent" DROP COLUMN "zone";

-- Legacy zone rows have no first-zone report timestamp. Leave primaryZone and
-- primaryZoneObservedAt NULL rather than inventing entry order from audit times.
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_observedZoneCount_check"
  CHECK ("observedZoneCount" = coalesce(cardinality("observedZones"), 0));

-- CreateTable
CREATE TABLE "EventZoneTransition" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "observationKey" VARCHAR(64) NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "beforeFrameTime" TIMESTAMPTZ(3),
    "beforeZones" TEXT[],
    "afterZones" TEXT[],
    "sourceType" VARCHAR(16) NOT NULL,

    CONSTRAINT "EventZoneTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventZoneTransition_eventId_observedAt_id_idx" ON "EventZoneTransition"("eventId", "observedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EventZoneTransition_eventId_observationKey_key" ON "EventZoneTransition"("eventId", "observationKey");

-- CreateIndex
CREATE INDEX "SecurityEvent_observedZones_idx" ON "SecurityEvent" USING GIN ("observedZones");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityEvent_frigateTrackingId_camera_key" ON "SecurityEvent"("frigateTrackingId", "camera");

-- CreateIndex
CREATE INDEX "SecurityEvent_primaryZone_createdAt_id_idx" ON "SecurityEvent"("primaryZone", "createdAt", "id");
CREATE INDEX "SecurityEvent_observedZoneCount_createdAt_id_idx" ON "SecurityEvent"("observedZoneCount", "createdAt", "id");
CREATE INDEX "SecurityEvent_camera_label_startedAt_idx" ON "SecurityEvent"("camera", "label", "startedAt");
CREATE INDEX "SecurityEvent_camera_label_primaryZone_startedAt_idx" ON "SecurityEvent"("camera", "label", "primaryZone", "startedAt");

-- AddForeignKey
ALTER TABLE "EventZoneTransition" ADD CONSTRAINT "EventZoneTransition_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
