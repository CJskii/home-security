-- Phase 4: additive source projections only; no backfill or source rewrites.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
-- CreateTable
CREATE TABLE "UniviewObject" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "sourceList" VARCHAR(128) NOT NULL,
    "sourceOrdinal" INTEGER NOT NULL,
    "sourceIdentifiers" JSONB NOT NULL,
    "sourceCategoryCode" TEXT,
    "sourceSubtypeCode" TEXT,
    "category" VARCHAR(32) NOT NULL,
    "classificationBasis" VARCHAR(32) NOT NULL,
    "positionRaw" TEXT,
    "coordinateStatus" VARCHAR(16) NOT NULL,
    "xMin" INTEGER,
    "yMin" INTEGER,
    "xMax" INTEGER,
    "yMax" INTEGER,
    "sourceTimestamp" TIMESTAMPTZ(3),
    "timestampBasis" VARCHAR(32) NOT NULL,
    "fullFrameImageIndex" INTEGER,
    "cropImageIndex" INTEGER,
    "fullFrameSnapshotId" UUID,
    "cropSnapshotId" UUID,
    "projectionVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "UniviewObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UniviewObject_eventId_category_idx" ON "UniviewObject"("eventId", "category");

-- CreateIndex
CREATE INDEX "UniviewObject_category_sourceTimestamp_id_idx" ON "UniviewObject"("category", "sourceTimestamp", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UniviewObject_notificationId_sourceList_sourceOrdinal_key" ON "UniviewObject"("notificationId", "sourceList", "sourceOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "EventSnapshot_eventId_notificationId_id_key" ON "EventSnapshot"("eventId", "notificationId", "id");

-- AddForeignKey
ALTER TABLE "UniviewObject" ADD CONSTRAINT "UniviewObject_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UniviewObject" ADD CONSTRAINT "UniviewObject_eventId_notificationId_fkey" FOREIGN KEY ("eventId", "notificationId") REFERENCES "UniviewNotification"("eventId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UniviewObject" ADD CONSTRAINT "UniviewObject_eventId_notificationId_fullFrameSnapshotId_fkey" FOREIGN KEY ("eventId", "notificationId", "fullFrameSnapshotId") REFERENCES "EventSnapshot"("eventId", "notificationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UniviewObject" ADD CONSTRAINT "UniviewObject_eventId_notificationId_cropSnapshotId_fkey" FOREIGN KEY ("eventId", "notificationId", "cropSnapshotId") REFERENCES "EventSnapshot"("eventId", "notificationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "UniviewObject"
  ADD CONSTRAINT "UniviewObject_category" CHECK ("category" IN ('PERSON','MOTOR_VEHICLE','NON_MOTOR_VEHICLE','UNKNOWN')),
  ADD CONSTRAINT "UniviewObject_identity" CHECK ("sourceOrdinal">=0 AND jsonb_typeof("sourceIdentifiers")='object'),
  ADD CONSTRAINT "UniviewObject_coordinates" CHECK (
    ("coordinateStatus"='VALID' AND "xMin" IS NOT NULL AND "yMin" IS NOT NULL AND "xMax" IS NOT NULL AND "yMax" IS NOT NULL
      AND "xMin">=0 AND "yMin">=0 AND "xMax"<=10000 AND "yMax"<=10000 AND "xMin"<"xMax" AND "yMin"<"yMax")
    OR ("coordinateStatus" IN ('MISSING','INVALID') AND "xMin" IS NULL AND "yMin" IS NULL AND "xMax" IS NULL AND "yMax" IS NULL)),
  ADD CONSTRAINT "UniviewObject_image_indices" CHECK (
    ("fullFrameImageIndex" IS NULL OR "fullFrameImageIndex">=0) AND ("cropImageIndex" IS NULL OR "cropImageIndex">=0)
    AND ("fullFrameSnapshotId" IS NULL OR "fullFrameImageIndex" IS NOT NULL)
    AND ("cropSnapshotId" IS NULL OR "cropImageIndex" IS NOT NULL));
COMMIT;
