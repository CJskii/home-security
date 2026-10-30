-- Additive ledger extension only. Does not arm updates or backfill prior alerts.
BEGIN;
SET LOCAL lock_timeout='2s';
ALTER TABLE "NotificationIntent" ADD COLUMN "parentId" UUID;
ALTER TABLE "NotificationIntent" DROP CONSTRAINT notification_intent_mode;
ALTER TABLE "NotificationIntent" ADD CONSTRAINT notification_intent_mode CHECK (
 (mode='LIVE' AND "eventId" IS NOT NULL AND "evaluationId" IS NOT NULL) OR
 (mode IN ('TEST','UPDATE') AND "eventId" IS NULL AND "evaluationId" IS NULL));
CREATE UNIQUE INDEX "NotificationIntent_parentId_key" ON "NotificationIntent"("parentId");
ALTER TABLE "NotificationIntent" ADD CONSTRAINT "NotificationIntent_parentId_fkey"
 FOREIGN KEY ("parentId") REFERENCES "NotificationIntent"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationIntent" ADD CONSTRAINT "notification_enrichment_identity"
 CHECK ((mode='UPDATE' AND "parentId" IS NOT NULL AND "parentId"<>id AND "eventId" IS NULL AND "evaluationId" IS NULL)
 OR (mode<>'UPDATE' AND "parentId" IS NULL));
COMMIT;
