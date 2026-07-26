-- A fixed-width retained identity for traces whose request detail has been shed.
-- It deliberately contains no captures, spans, dimensions, or aggregate-derived values: every
-- value is copied from the per-trace observation reduction before its source partition drops.
-- forward-fix: retain compacted identities and add a successor projection rather than reconstructing shed detail.
CREATE TABLE "compacted_trace_projection" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "trace_id" text NOT NULL,
  "compacted_at" timestamp with time zone NOT NULL,
  "input_tokens" bigint NOT NULL,
  "output_tokens" bigint NOT NULL,
  "cache_read_tokens" bigint NOT NULL,
  "reasoning_tokens" bigint NOT NULL,
  "cache_write_tokens" bigint NOT NULL,
  "audio_input_tokens" bigint NOT NULL,
  "audio_output_tokens" bigint NOT NULL,
  "usage_fidelity" text NOT NULL,
  "cost_microusd" bigint NOT NULL,
  "cost_fidelity" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "trace_id"),
  CONSTRAINT "compacted_trace_projection_usage_fidelity_chk" CHECK ("usage_fidelity" IN ('exact','estimated','unknown')),
  CONSTRAINT "compacted_trace_projection_cost_fidelity_chk" CHECK ("cost_fidelity" IN ('exact','estimated','unknown'))
);--> statement-breakpoint
CREATE INDEX "compacted_trace_projection_compacted_idx" ON "compacted_trace_projection" ("workspace_id", "compacted_at" DESC);--> statement-breakpoint

ALTER TABLE "compacted_trace_projection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compacted_trace_projection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "compacted_trace_projection_rls" ON "compacted_trace_projection"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "compacted_trace_projection" TO manifold_app;
