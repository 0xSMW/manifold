-- Durable, fail-closed storage retention.  This migration deliberately grants no authority to
-- delete data: only the direct worker may act after an export manifest and checkpoint exist.
-- forward-fix: disable retention processing and repair state with a later migration; do not delete retained data.
CREATE TABLE "storage_retention_setting" (
  "workspace_id" text PRIMARY KEY NOT NULL REFERENCES "workspace"("id"),
  "observation_retention_days" integer NOT NULL DEFAULT 30,
  "export_target" text NOT NULL DEFAULT 'disabled',
  "export_location" text,
  "enabled_at" timestamp with time zone,
  "updated_by_kind" text,
  "updated_by_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "storage_retention_days_chk" CHECK ("observation_retention_days" BETWEEN 1 AND 3650),
  CONSTRAINT "storage_retention_target_chk" CHECK ("export_target" IN ('disabled','local_filesystem','object_storage')),
  CONSTRAINT "storage_retention_location_chk" CHECK (
    ("export_target" = 'disabled' AND "export_location" IS NULL AND "enabled_at" IS NULL)
    OR ("export_target" <> 'disabled' AND "export_location" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE TABLE "storage_export_manifest" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "source_relation" text NOT NULL,
  "partition_name" text NOT NULL,
  "range_start" timestamp with time zone NOT NULL,
  "range_end" timestamp with time zone NOT NULL,
  "target_kind" text NOT NULL,
  "target_uri" text NOT NULL,
  "sha256" text NOT NULL,
  "row_count" bigint NOT NULL,
  "byte_count" bigint NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "storage_export_manifest_target_chk" CHECK ("target_kind" IN ('local_filesystem','object_storage')),
  CONSTRAINT "storage_export_manifest_sha_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "storage_export_manifest_counts_chk" CHECK ("row_count" >= 0 AND "byte_count" >= 0),
  CONSTRAINT "storage_export_manifest_relation_chk" CHECK ("source_relation" IN ('observation','observation_event','trace_summary','policy_decision')),
  CONSTRAINT "storage_export_manifest_range_chk" CHECK ("range_end" > "range_start")
);--> statement-breakpoint
CREATE UNIQUE INDEX "storage_export_manifest_partition_uq" ON "storage_export_manifest" ("workspace_id","partition_name","sha256");--> statement-breakpoint
CREATE INDEX "storage_export_manifest_lookup_idx" ON "storage_export_manifest" ("workspace_id","source_relation","range_end" DESC);--> statement-breakpoint
CREATE TRIGGER "storage_export_manifest_immutable" BEFORE UPDATE OR DELETE ON "storage_export_manifest"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

CREATE TABLE "storage_compaction_checkpoint" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "partition_name" text NOT NULL,
  "export_manifest_id" text NOT NULL REFERENCES "storage_export_manifest"("id"),
  "state" text NOT NULL DEFAULT 'export_verified',
  "drop_authorized_at" timestamp with time zone,
  "dropped_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id","partition_name"),
  CONSTRAINT "storage_checkpoint_state_chk" CHECK ("state" IN ('export_verified','drop_authorized','dropped')),
  CONSTRAINT "storage_checkpoint_state_fields_chk" CHECK (
    ("state" = 'export_verified' AND "drop_authorized_at" IS NULL AND "dropped_at" IS NULL)
    OR ("state" = 'drop_authorized' AND "drop_authorized_at" IS NOT NULL AND "dropped_at" IS NULL)
    OR ("state" = 'dropped' AND "drop_authorized_at" IS NOT NULL AND "dropped_at" IS NOT NULL)
  )
);--> statement-breakpoint

ALTER TABLE "storage_retention_setting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_retention_setting" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_retention_setting_rls" ON "storage_retention_setting"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
ALTER TABLE "storage_export_manifest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_export_manifest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_export_manifest_rls" ON "storage_export_manifest"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
ALTER TABLE "storage_compaction_checkpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_compaction_checkpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_compaction_checkpoint_rls" ON "storage_compaction_checkpoint"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_retention_setting" TO manifold_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_export_manifest" TO manifold_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_compaction_checkpoint" TO manifold_app;
