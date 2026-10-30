-- Explicit operator migration. Does not configure a destination or arm delivery.
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE "NotificationConfiguration"
 ADD COLUMN "deliveryRevision" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "deliveryUpdatedAt" TIMESTAMPTZ(3),
 ADD COLUMN "deliveryConfiguration" JSONB,
 ADD COLUMN "deliverySecret" TEXT;
ALTER TABLE "NotificationIntent"
 ADD COLUMN mode VARCHAR(8) NOT NULL DEFAULT 'LIVE',
 ALTER COLUMN "eventId" DROP NOT NULL,
 ALTER COLUMN "evaluationId" DROP NOT NULL,
 ADD CONSTRAINT notification_intent_mode CHECK (
  (mode='LIVE' AND "eventId" IS NOT NULL AND "evaluationId" IS NOT NULL) OR
  (mode='TEST' AND "eventId" IS NULL AND "evaluationId" IS NULL)
 );
CREATE INDEX "notification_test_history_idx" ON "NotificationIntent"("sourceInstallationId",mode,"createdAt");
COMMIT;
