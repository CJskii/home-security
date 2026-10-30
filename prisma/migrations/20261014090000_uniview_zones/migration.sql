-- Phase 5: additive zone metadata only, no source updates or backfill.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
-- CreateTable
CREATE TABLE "UniviewZone" (
    "id" UUID NOT NULL,
    "sourceInstallationId" UUID NOT NULL,
    "channel" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "displayName" VARCHAR(128) NOT NULL,
    "nameUpdatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UniviewZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniviewZoneVersion" (
    "id" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "displayName" VARCHAR(128) NOT NULL,
    "nameEffectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "ruleEnabled" BOOLEAN NOT NULL,
    "polygon" JSONB NOT NULL,
    "geometryFingerprint" VARCHAR(64) NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastObservedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UniviewZoneVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectZoneEvidence" (
    "objectId" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "zoneVersionId" UUID,
    "sourceRules" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "enrichedAt" TIMESTAMPTZ(3) NOT NULL,
    "algorithmVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ObjectZoneEvidence_pkey" PRIMARY KEY ("objectId")
);

-- CreateTable
CREATE TABLE "ObjectZoneMembership" (
    "objectId" UUID NOT NULL,
    "zoneVersionId" UUID NOT NULL,
    "relationship" VARCHAR(16) NOT NULL,

    CONSTRAINT "ObjectZoneMembership_pkey" PRIMARY KEY ("objectId","zoneVersionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "UniviewZone_sourceInstallationId_channel_slot_key" ON "UniviewZone"("sourceInstallationId", "channel", "slot");

-- CreateIndex
CREATE INDEX "UniviewZoneVersion_observedAt_lastObservedAt_idx" ON "UniviewZoneVersion"("observedAt", "lastObservedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UniviewZoneVersion_zoneId_revision_key" ON "UniviewZoneVersion"("zoneId", "revision");

-- Reverse lookups for event-history zone filters; FK columns are not indexed automatically.
CREATE INDEX "ObjectZoneEvidence_zoneVersionId_idx" ON "ObjectZoneEvidence"("zoneVersionId");
CREATE INDEX "ObjectZoneMembership_zoneVersionId_idx" ON "ObjectZoneMembership"("zoneVersionId");

-- AddForeignKey
ALTER TABLE "UniviewZoneVersion" ADD CONSTRAINT "UniviewZoneVersion_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "UniviewZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectZoneEvidence" ADD CONSTRAINT "ObjectZoneEvidence_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "UniviewObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectZoneEvidence" ADD CONSTRAINT "ObjectZoneEvidence_zoneVersionId_fkey" FOREIGN KEY ("zoneVersionId") REFERENCES "UniviewZoneVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectZoneMembership" ADD CONSTRAINT "ObjectZoneMembership_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "UniviewObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectZoneMembership" ADD CONSTRAINT "ObjectZoneMembership_zoneVersionId_fkey" FOREIGN KEY ("zoneVersionId") REFERENCES "UniviewZoneVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "UniviewZone" ADD CONSTRAINT "UniviewZone_slot_range" CHECK ("slot" BETWEEN 0 AND 3 AND "channel" BETWEEN 1 AND 2);
ALTER TABLE "UniviewZoneVersion"
  ADD CONSTRAINT "UniviewZoneVersion_observations" CHECK ("revision">0 AND "lastObservedAt">="observedAt"),
  ADD CONSTRAINT "UniviewZoneVersion_polygon" CHECK (jsonb_typeof("polygon")='array' AND jsonb_array_length("polygon") IN (0,4)),
  ADD CONSTRAINT "UniviewZoneVersion_fingerprint" CHECK ("geometryFingerprint" ~ '^[a-f0-9]{64}$');
ALTER TABLE "ObjectZoneEvidence"
  ADD CONSTRAINT "ObjectZoneEvidence_status" CHECK ("status" IN ('CONFIRMED_GEOMETRY_MATCH','AMBIGUOUS','UNKNOWN')),
  ADD CONSTRAINT "ObjectZoneEvidence_confirmed" CHECK (("status"='CONFIRMED_GEOMETRY_MATCH')=("zoneVersionId" IS NOT NULL)),
  ADD CONSTRAINT "ObjectZoneEvidence_source_rules" CHECK (jsonb_typeof("sourceRules")='array' AND jsonb_array_length("sourceRules")<=32 AND octet_length("sourceRules"::text)<=262144);
ALTER TABLE "ObjectZoneMembership" ADD CONSTRAINT "ObjectZoneMembership_relationship" CHECK ("relationship" IN ('WITHIN','INTERSECTS','OUTSIDE'));
COMMIT;
