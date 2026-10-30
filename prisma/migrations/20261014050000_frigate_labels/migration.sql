-- Persist the submitted label so retries/closure never reclassify an existing event.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN IF current_database() <> 'security_events' THEN RAISE EXCEPTION 'Expected security_events'; END IF; END $$;
ALTER TABLE "FrigateDelivery" ADD COLUMN "label" VARCHAR(16) NOT NULL DEFAULT 'Motion';
ALTER TABLE "FrigateDelivery" ADD CONSTRAINT "FrigateDelivery_label" CHECK ("label" IN ('Motion','person','car','motion'));
COMMIT;
