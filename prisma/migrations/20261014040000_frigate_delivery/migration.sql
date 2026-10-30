-- M2: additive downstream presentation state. No source/event/media changes.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
CREATE TABLE "FrigateDelivery" (
  "eventId" UUID NOT NULL,
  "camera" VARCHAR(128) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "frigateEventId" VARCHAR(128),
  "durationSeconds" INTEGER NOT NULL,
  "submittedAt" TIMESTAMPTZ(3), "closeAt" TIMESTAMPTZ(3),
  "finishedAt" TIMESTAMPTZ(3), "nextAttemptAt" TIMESTAMPTZ(3),
  "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" VARCHAR(64),
  CONSTRAINT "FrigateDelivery_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "FrigateDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FrigateDelivery_status" CHECK ("status" IN ('PENDING','CREATING','UNCERTAIN','OPEN','CLOSED','FAILED')),
  CONSTRAINT "FrigateDelivery_bounds" CHECK ("attempts">=0 AND "durationSeconds" BETWEEN 1 AND 300 AND "camera" IN ('camera_1','camera_2')),
  CONSTRAINT "FrigateDelivery_open_fields" CHECK ("status" NOT IN ('OPEN','CLOSED') OR ("frigateEventId" IS NOT NULL AND "submittedAt" IS NOT NULL AND "closeAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "FrigateDelivery_frigateEventId_key" ON "FrigateDelivery"("frigateEventId");
CREATE INDEX "FrigateDelivery_status_nextAttemptAt_idx" ON "FrigateDelivery"("status", "nextAttemptAt");
COMMIT;
