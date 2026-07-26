-- Preserve every token category when usage detail is compacted. These are additive so already
-- retained aggregate rows remain valid and simply report zero until their source is re-rolled.
-- forward-fix: retain aggregates and add corrective derived fields rather than rewriting ledger history.
ALTER TABLE "usage_aggregate" ADD COLUMN "cache_write_tokens" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "audio_input_tokens" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "usage_aggregate" ADD COLUMN "audio_output_tokens" bigint NOT NULL DEFAULT 0;--> statement-breakpoint

-- Per-request usage/cost detail may be partition-dropped only after the compactor has proved
-- the corresponding aggregate truth. Permit immutable manifests for those sources; compactor
-- code remains fail-closed unless the required proof and checkpoint exist.
ALTER TABLE "storage_export_manifest"
  DROP CONSTRAINT "storage_export_manifest_relation_chk";--> statement-breakpoint
ALTER TABLE "storage_export_manifest"
  ADD CONSTRAINT "storage_export_manifest_relation_chk"
  CHECK ("source_relation" IN ('observation','observation_event','trace_summary','policy_decision','usage_record','cost_ledger'));
