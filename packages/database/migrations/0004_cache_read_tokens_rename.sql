-- ===========================================================================
-- 0004_cache_read_tokens_rename.sql — rename the cache-READ token column so it is
--   unambiguous alongside cache_write_tokens (§6.10 cost formula). PURE RENAME.
-- forward-fix: use a successor migration for any compatibility column or view; do not silently rewrite usage data.
--
-- `cached_tokens` counted cache-READ tokens (billed at cacheReadPerMtokMicroUsd),
-- but the bare name did not distinguish read from write. Renaming to
-- `cache_read_tokens` mirrors the existing `cache_write_tokens` column and keeps the
-- Drizzle schema, the domain TokenCounts.cacheReadTokens field, and the §6.10 cost
-- math all speaking the same name. RENAME COLUMN is metadata-only — no rewrite, no
-- data loss. Each of these three tables is a partitioned parent, so the rename
-- cascades to every existing partition automatically.
-- ===========================================================================
ALTER TABLE "observation" RENAME COLUMN "cached_tokens" TO "cache_read_tokens";--> statement-breakpoint
ALTER TABLE "usage_record" RENAME COLUMN "cached_tokens" TO "cache_read_tokens";--> statement-breakpoint
ALTER TABLE "usage_aggregate" RENAME COLUMN "cached_tokens" TO "cache_read_tokens";
