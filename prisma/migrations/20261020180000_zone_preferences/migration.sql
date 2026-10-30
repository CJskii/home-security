-- Explicit operator migration only. No source rows or zone versions are changed.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
CREATE TABLE "ZonePreference" (
  "zoneId" UUID NOT NULL,
  "displayName" VARCHAR(128),
  "interested" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ZonePreference_pkey" PRIMARY KEY ("zoneId"),
  CONSTRAINT "ZonePreference_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "UniviewZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ZonePreference_displayName" CHECK ("displayName" IS NULL OR (length(btrim("displayName")) BETWEEN 1 AND 128 AND "displayName" !~ '[[:cntrl:]]'))
);
COMMIT;
