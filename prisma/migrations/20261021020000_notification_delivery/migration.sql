-- Disabled infrastructure only; never backfill or arm the live producer here.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE INDEX "notification_source_scan_idx" ON "SecurityEvent"("sourceInstallationId","firstReceivedAt",id);
ALTER TABLE "NotificationConfiguration"
 ADD COLUMN "producerEnabled" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "liveFromAt" TIMESTAMPTZ(3),
 ADD COLUMN "scannedAt" TIMESTAMPTZ(3),
 ADD COLUMN "scannedId" UUID;
ALTER TABLE "NotificationEvaluation"
 ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'PREVIEW',
 ADD COLUMN "state" VARCHAR(24) NOT NULL DEFAULT 'AUDIT',
 ADD COLUMN "eventId" UUID,
 ADD COLUMN "availableAt" TIMESTAMPTZ(3),
 ADD CONSTRAINT "NotificationEvaluation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "NotificationEvaluation_sourceInstallationId_eventId_key" ON "NotificationEvaluation"("sourceInstallationId","eventId");
CREATE INDEX "notification_evaluation_due_idx" ON "NotificationEvaluation"("sourceInstallationId",state,"availableAt");
CREATE TABLE "NotificationIntent" (
 id UUID PRIMARY KEY,"sourceInstallationId" UUID NOT NULL,"eventId" UUID NOT NULL UNIQUE,
 "evaluationId" UUID NOT NULL UNIQUE,"destinationId" VARCHAR(64) NOT NULL,payload JSONB NOT NULL,
 state VARCHAR(24) NOT NULL DEFAULT 'READY',"nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,"attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount">=0),
 "leaseToken" UUID,"leaseUntil" TIMESTAMPTZ(3),"deliveredAt" TIMESTAMPTZ(3),"lastError" VARCHAR(64),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "NotificationIntent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "NotificationIntent_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "NotificationEvaluation"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "notification_intent_due_idx" ON "NotificationIntent"("sourceInstallationId",state,"nextAttemptAt");
CREATE TABLE "NotificationAttempt" (
 id UUID PRIMARY KEY,"intentId" UUID NOT NULL,ordinal INTEGER NOT NULL CHECK (ordinal>0),"leaseToken" UUID NOT NULL,
 "startedAt" TIMESTAMPTZ(3) NOT NULL,"finishedAt" TIMESTAMPTZ(3),outcome VARCHAR(24) NOT NULL,
 "httpStatus" INTEGER,"errorCode" VARCHAR(64),"durationMs" INTEGER,"mayHaveReached" BOOLEAN NOT NULL DEFAULT false,receipt VARCHAR(16),
 CONSTRAINT "NotificationAttempt_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "NotificationIntent"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationAttempt_intentId_ordinal_key" ON "NotificationAttempt"("intentId",ordinal);
CREATE TABLE "NotificationCooldown" (
 "sourceInstallationId" UUID NOT NULL,"scopeKey" VARCHAR(64) NOT NULL,"ruleId" UUID NOT NULL,
 channel INTEGER NOT NULL,"cooldownSeconds" INTEGER NOT NULL CHECK ("cooldownSeconds">=0 AND "cooldownSeconds"<=86400),
 "lastDeliveredAt" TIMESTAMPTZ(3),"reservationId" UUID,
 PRIMARY KEY ("sourceInstallationId","scopeKey"),
 CONSTRAINT "NotificationCooldown_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "NotificationIntent"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
-- Atomic producer, armed only by a separate operator-approved cutoff/flag. Failures
-- must never prevent canonical capture; bounded worker reconciliation repairs gaps.
CREATE FUNCTION home_security_notification_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg "NotificationConfiguration"; previous_timeout text;
BEGIN
 previous_timeout := current_setting('lock_timeout');
 BEGIN
  PERFORM set_config('lock_timeout','100ms',true);
  SELECT * INTO cfg FROM "NotificationConfiguration" WHERE "sourceInstallationId"=NEW."sourceInstallationId";
  IF NOT FOUND OR NOT cfg."producerEnabled" OR cfg."liveFromAt" IS NULL
     OR NEW."firstReceivedAt"<cfg."liveFromAt" THEN
   PERFORM set_config('lock_timeout',previous_timeout,true);
   RETURN NEW;
  END IF;
  INSERT INTO "NotificationEvaluation"(id,"sourceInstallationId",fingerprint,"configurationRevision",configuration,result,kind,state,"eventId","availableAt")
  VALUES(gen_random_uuid(),NEW."sourceInstallationId",'live:'||NEW.id::text,cfg.revision,cfg.configuration,'{}','LIVE','PENDING',NEW.id,clock_timestamp()+interval '2 seconds')
  ON CONFLICT ("sourceInstallationId","eventId") DO NOTHING;
  PERFORM pg_notify('home_security_notifications','');
  PERFORM set_config('lock_timeout',previous_timeout,true);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('lock_timeout',previous_timeout,true);
  RAISE WARNING 'NOTIFICATION_ENQUEUE_UNAVAILABLE';
 END;
 RETURN NEW;
END;
$$;
CREATE TRIGGER home_security_notification_enqueue_trigger AFTER INSERT OR UPDATE OF "lastReceivedAt" ON "SecurityEvent"
 FOR EACH ROW EXECUTE FUNCTION home_security_notification_enqueue();
COMMIT;
