-- A retry-stable export epoch records in-progress/failed partition work without falsely
-- claiming a verified manifest. It also makes a run that succeeds on an earlier partition and
-- fails later externally visible and resumable.
-- forward-fix: retain attempt evidence and resume or repair export state through a later migration.
CREATE TABLE "storage_export_attempt" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "partition_name" text NOT NULL,
  "source_relation" text NOT NULL,
  "exported_at" timestamp with time zone NOT NULL,
  "state" text NOT NULL DEFAULT 'exporting',
  "export_manifest_id" text,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "partition_name"),
  CONSTRAINT "storage_export_attempt_state_chk" CHECK ("state" IN ('exporting','verified','failed')),
  CONSTRAINT "storage_export_attempt_shape_chk" CHECK (
    ("state" = 'exporting' AND "export_manifest_id" IS NULL)
    OR ("state" = 'verified' AND "export_manifest_id" IS NOT NULL AND "last_error" IS NULL)
    OR ("state" = 'failed' AND "export_manifest_id" IS NULL AND "last_error" IS NOT NULL)
  ),
  CONSTRAINT "storage_export_attempt_workspace_manifest_fk"
    FOREIGN KEY ("workspace_id", "export_manifest_id")
    REFERENCES "storage_export_manifest" ("workspace_id", "id")
);--> statement-breakpoint
ALTER TABLE "storage_export_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_export_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "storage_export_attempt_rls" ON "storage_export_attempt"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_export_attempt" TO manifold_app;
