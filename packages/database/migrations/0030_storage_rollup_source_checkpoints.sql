-- Durable per-dimension source contributions for late aggregate correction (§13.4-§13.7).
-- forward-fix: preserve checkpoint contributions and repair them with a successor migration.
-- rollback: do not drop live proof state; disable its writer/reader in a successor migration.
--
-- A completed daily/monthly rollup retains each normalized source-bucket contribution.  When
-- retention has pruned sibling source buckets, a late source bucket can be replaced exactly
-- against this durable proof without erasing those siblings from the target grain.
-- Existing 0029 checkpoints are intentionally not synthesized here: migrations cannot prove
-- that their source siblings remain complete. Runtime establishes a baseline only when retained
-- source and target both equal the legacy exact checkpoint; source pruning is blocked until then.
CREATE TABLE "storage_rollup_source_checkpoint" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "source_grain" text NOT NULL,
  "target_grain" text NOT NULL,
  "bucket_start" timestamp with time zone NOT NULL,
  "source_bucket_start" timestamp with time zone NOT NULL,
  "dims" jsonb NOT NULL,
  "dims_hash" text NOT NULL,
  "requests" bigint NOT NULL,
  "input_tokens" bigint NOT NULL,
  "output_tokens" bigint NOT NULL,
  "cache_read_tokens" bigint NOT NULL,
  "reasoning_tokens" bigint NOT NULL,
  "cache_write_tokens" bigint NOT NULL,
  "audio_input_tokens" bigint NOT NULL,
  "audio_output_tokens" bigint NOT NULL,
  "cost_microusd" bigint NOT NULL,
  "errors" bigint NOT NULL,
  "failovers" bigint NOT NULL,
  "latency_ms_sum" bigint NOT NULL,
  "completed_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "source_grain", "target_grain", "bucket_start", "source_bucket_start", "dims_hash"),
  CONSTRAINT "storage_rollup_source_checkpoint_grain_chk" CHECK (
    ("source_grain"='hourly' AND "target_grain"='daily')
    OR ("source_grain"='daily' AND "target_grain"='monthly')
  ),
  CONSTRAINT "storage_rollup_source_checkpoint_window_chk" CHECK (
    "source_bucket_start" >= "bucket_start" AND (
      ("target_grain"='daily' AND "source_bucket_start" < "bucket_start" + interval '1 day')
      OR ("target_grain"='monthly' AND "source_bucket_start" < "bucket_start" + interval '1 month')
    )
  ),
  CONSTRAINT "storage_rollup_source_checkpoint_nonnegative_chk" CHECK (
    "requests" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0
    AND "cache_read_tokens" >= 0 AND "reasoning_tokens" >= 0 AND "cache_write_tokens" >= 0
    AND "audio_input_tokens" >= 0 AND "audio_output_tokens" >= 0 AND "cost_microusd" >= 0
    AND "errors" >= 0 AND "failovers" >= 0 AND "latency_ms_sum" >= 0
  )
);--> statement-breakpoint

ALTER TABLE "storage_rollup_source_checkpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_rollup_source_checkpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_rollup_source_checkpoint_rls" ON "storage_rollup_source_checkpoint"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_rollup_source_checkpoint" TO manifold_app;
