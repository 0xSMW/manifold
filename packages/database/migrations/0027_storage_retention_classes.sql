-- Relation-specific retention floors and exact grain-rollup authorization (§13.3-§13.7).
-- forward-fix: preserve existing retention settings and adjust floors or proof rules in a successor migration.
ALTER TABLE "storage_retention_setting"
  ADD COLUMN "min_detail_hours" integer NOT NULL DEFAULT 24,
  ADD COLUMN "journal_retention_hours" integer NOT NULL DEFAULT 72,
  ADD COLUMN "capture_retention_hours" integer NOT NULL DEFAULT 24,
  ADD COLUMN "min_trace_days" integer NOT NULL DEFAULT 7,
  ADD COLUMN "cost_ledger_retention_days" integer NOT NULL DEFAULT 30,
  ADD COLUMN "policy_decision_retention_days" integer NOT NULL DEFAULT 90,
  ADD COLUMN "hourly_aggregate_retention_days" integer NOT NULL DEFAULT 14,
  ADD COLUMN "daily_aggregate_retention_days" integer NOT NULL DEFAULT 400,
  ADD CONSTRAINT "storage_retention_detail_floor_chk"
    CHECK ("min_detail_hours" >= 1 AND "journal_retention_hours" >= "min_detail_hours"),
  ADD CONSTRAINT "storage_retention_capture_chk"
    CHECK ("capture_retention_hours" BETWEEN 1 AND 8760),
  ADD CONSTRAINT "storage_retention_trace_floor_chk"
    CHECK ("min_trace_days" >= 1 AND "observation_retention_days" >= "min_trace_days"),
  ADD CONSTRAINT "storage_retention_cost_floor_chk"
    CHECK ("cost_ledger_retention_days" >= "min_trace_days"),
  ADD CONSTRAINT "storage_retention_policy_floor_chk"
    CHECK ("policy_decision_retention_days" >= 90),
  ADD CONSTRAINT "storage_retention_aggregate_chk"
    CHECK ("hourly_aggregate_retention_days" >= 1
      AND "daily_aggregate_retention_days" >= "hourly_aggregate_retention_days");--> statement-breakpoint

-- A source grain can be pruned only while the durable target still matches exact_totals.
-- No monthly-to-coarser transition exists, so monthly truth has no deletion authorization.
CREATE TABLE "storage_rollup_checkpoint" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "source_grain" text NOT NULL,
  "target_grain" text NOT NULL,
  "bucket_start" timestamp with time zone NOT NULL,
  "bucket_end" timestamp with time zone NOT NULL,
  "exact_totals" jsonb NOT NULL,
  "completed_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "target_grain", "bucket_start"),
  CONSTRAINT "storage_rollup_checkpoint_grain_chk" CHECK (
    ("source_grain"='observation' AND "target_grain"='hourly')
    OR ("source_grain"='hourly' AND "target_grain"='daily')
    OR ("source_grain"='daily' AND "target_grain"='monthly')
  ),
  CONSTRAINT "storage_rollup_checkpoint_range_chk" CHECK ("bucket_end" > "bucket_start")
);--> statement-breakpoint

ALTER TABLE "storage_rollup_checkpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_rollup_checkpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_rollup_checkpoint_rls" ON "storage_rollup_checkpoint"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "storage_rollup_checkpoint" TO manifold_app;
