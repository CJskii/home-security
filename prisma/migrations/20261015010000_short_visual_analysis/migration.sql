-- Forward-only AI metadata cleanup. Requires a coordinated API/receiver release:
-- the previous Prisma client reads/writes these columns. Never run at startup.
-- No canonical event, notification, object, snapshot/hash/reference or zone is deleted.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=public,pg_catalog;
DO $$ BEGIN IF current_database()<>'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
ALTER TABLE "ObjectAnalysis" DROP CONSTRAINT "ObjectAnalysis_continuity";
ALTER TABLE "ObjectAnalysis"
  DROP COLUMN "detailedDescription",
  DROP COLUMN "continuity",
  DROP COLUMN "movementDirection";
ALTER TABLE "EventAnalysis"
  DROP COLUMN "detailedDescription",
  DROP COLUMN "movementDirection";
COMMIT;
