-- A checkpoint must never cite another workspace's immutable manifest. The original FK on
-- export_manifest_id alone proves that a manifest exists, but not that it belongs to the same
-- tenant as the checkpoint protected by RLS.
-- forward-fix: repair invalid checkpoint references before adding any successor constraint.
ALTER TABLE "storage_export_manifest"
  ADD CONSTRAINT "storage_export_manifest_workspace_id_id_uq" UNIQUE ("workspace_id", "id");--> statement-breakpoint

ALTER TABLE "storage_compaction_checkpoint"
  DROP CONSTRAINT IF EXISTS "storage_compaction_checkpoint_export_manifest_id_storage_export_manifest_id_fk";--> statement-breakpoint

ALTER TABLE "storage_compaction_checkpoint"
  ADD CONSTRAINT "storage_checkpoint_workspace_manifest_fk"
  FOREIGN KEY ("workspace_id", "export_manifest_id")
  REFERENCES "storage_export_manifest" ("workspace_id", "id");
