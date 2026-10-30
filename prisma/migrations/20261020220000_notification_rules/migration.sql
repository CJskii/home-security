-- Operator applied only. No source data changes and no automatic delivery.
CREATE TABLE "NotificationConfiguration" (
  "sourceInstallationId" UUID NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "configuration" JSONB NOT NULL CHECK (jsonb_typeof("configuration") = 'object'),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "NotificationEvaluation" (
  "id" UUID NOT NULL PRIMARY KEY,
  "sourceInstallationId" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "configurationRevision" INTEGER NOT NULL,
  "configuration" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "NotificationEvaluation_sourceInstallationId_fingerprint_key" ON "NotificationEvaluation"("sourceInstallationId", "fingerprint");
CREATE INDEX "NotificationEvaluation_sourceInstallationId_createdAt_idx" ON "NotificationEvaluation"("sourceInstallationId", "createdAt");
