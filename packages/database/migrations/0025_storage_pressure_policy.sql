-- Additive storage-pressure action seam (SPEC §13.2-13.3).
-- rollback: redeploy prior code; these additive rows/column are harmless to it.
ALTER TABLE "storage_stat" ADD COLUMN "effective_ceiling_bytes" bigint;--> statement-breakpoint

CREATE TABLE "storage_pressure_state" (
  "workspace_id" text PRIMARY KEY NOT NULL REFERENCES "workspace"("id"),
  "tier" text NOT NULL,
  "capture_mode" text NOT NULL,
  "payload_sample_rate" numeric NOT NULL,
  "journal_mode" text NOT NULL,
  "trigger_compaction" boolean NOT NULL,
  "compact_every_measure" boolean NOT NULL,
  "block_non_essential_growth" boolean NOT NULL,
  "measured_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "storage_pressure_state_tier_chk" CHECK ("tier" IN ('normal','warning','high','critical','emergency')),
  CONSTRAINT "storage_pressure_capture_mode_chk" CHECK ("capture_mode" IN ('none','metadata','redacted','full')),
  CONSTRAINT "storage_pressure_sample_rate_chk" CHECK ("payload_sample_rate" >= 0 AND "payload_sample_rate" <= 1),
  CONSTRAINT "storage_pressure_journal_mode_chk" CHECK ("journal_mode" IN ('full','aggregate_only'))
);--> statement-breakpoint

CREATE TABLE "storage_pressure_alert" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "tier" text NOT NULL,
  "opened_at" timestamp with time zone NOT NULL,
  "last_transition_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone,
  "transition_count" integer NOT NULL DEFAULT 1,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "tier"),
  CONSTRAINT "storage_pressure_alert_tier_chk" CHECK ("tier" IN ('warning','high','critical','emergency')),
  CONSTRAINT "storage_pressure_alert_count_chk" CHECK ("transition_count" > 0)
);--> statement-breakpoint

ALTER TABLE "storage_pressure_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_pressure_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_pressure_state_rls" ON "storage_pressure_state"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
ALTER TABLE "storage_pressure_alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_pressure_alert" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_pressure_alert_rls" ON "storage_pressure_alert"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_pressure_state" TO manifold_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_pressure_alert" TO manifold_app;
