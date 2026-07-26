-- Partition export is a three-phase protocol: seal+detach (short transaction), export outside
-- Postgres, then revalidate+drop (short transaction). A seal is intentionally durable so a
-- crash can resume from the detached relation without reopening writes.
-- forward-fix: preserve seals and use a successor migration to repair metadata before any drop.
CREATE TABLE "storage_partition_seal" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "partition_name" text NOT NULL,
  "source_relation" text NOT NULL,
  "sealed_relation" text NOT NULL,
  "relation_oid" oid NOT NULL,
  "partition_bound" text NOT NULL,
  "range_start" timestamp with time zone NOT NULL,
  "range_end" timestamp with time zone NOT NULL,
  "seal_token" text NOT NULL,
  "attempt_token" text NOT NULL,
  "object_key" text NOT NULL,
  "state" text NOT NULL DEFAULT 'sealed',
  "export_manifest_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "partition_name"),
  CONSTRAINT "storage_partition_seal_state_chk" CHECK ("state" IN ('sealed','export_verified','dropped')),
  CONSTRAINT "storage_partition_seal_workspace_manifest_fk"
    FOREIGN KEY ("workspace_id", "export_manifest_id") REFERENCES "storage_export_manifest" ("workspace_id", "id")
);--> statement-breakpoint
ALTER TABLE "storage_partition_seal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_partition_seal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "storage_partition_seal_rls" ON "storage_partition_seal"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_partition_seal" TO manifold_app;
