-- ===========================================================================
-- 0007_drop_dead_revision_columns.sql — drop the denormalized route_ids /
--   policy_ids / price_ids columns on gateway_config_revision
--   (F11-dead-revision-columns).
--
-- These three jsonb columns were derived from the revision `snapshot` at apply
-- time and written on every publish, but NOTHING ever SELECTed them back: plan()
-- and diff() read the `snapshot` jsonb directly, and readActiveRevision /
-- readRevisionById never projected them. They were pure write amplification.
--
-- `content_hash` remains the indexed revision identity (config_revision_hash_uq);
-- any consumer that ever needs the id sets recomputes them from `snapshot`.
-- IF EXISTS keeps this idempotent and safe on a DB where a prior partial run
-- already dropped a column.
-- ===========================================================================
ALTER TABLE "gateway_config_revision" DROP COLUMN IF EXISTS "route_ids";--> statement-breakpoint
ALTER TABLE "gateway_config_revision" DROP COLUMN IF EXISTS "policy_ids";--> statement-breakpoint
ALTER TABLE "gateway_config_revision" DROP COLUMN IF EXISTS "price_ids";
