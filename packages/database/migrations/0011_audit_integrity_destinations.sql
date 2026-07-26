-- Audit integrity for records written after this migration.  Existing audit rows deliberately
-- remain unsealed: backfilling a chain would create an assertion that did not exist at write time.
-- forward-fix: preserve existing chain evidence and append a repair migration; never rewrite sealed history.
ALTER TABLE "audit_event"
  ADD COLUMN "chain_version" integer,
  ADD COLUMN "chain_sequence" bigint,
  ADD COLUMN "prev_chain_hash" bytea,
  ADD COLUMN "chain_hash" bytea,
  ADD COLUMN "chain_sealed_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "audit_event"
  ADD CONSTRAINT "audit_event_chain_shape_chk" CHECK (
    ("chain_version" IS NULL AND "chain_sequence" IS NULL AND "prev_chain_hash" IS NULL AND "chain_hash" IS NULL AND "chain_sealed_at" IS NULL)
    OR
    ("chain_version" = 1 AND "chain_sequence" > 0 AND octet_length("chain_hash") = 32 AND "chain_sealed_at" IS NOT NULL
      AND ("prev_chain_hash" IS NULL OR octet_length("prev_chain_hash") = 32))
  );
--> statement-breakpoint
CREATE INDEX "audit_chain_workspace_order_idx"
  ON "audit_event" ("workspace_id", "chain_sequence")
  WHERE "chain_version" = 1;
--> statement-breakpoint

-- Destinations store only envelope ciphertext. Neither a webhook token nor a URL carrying one
-- can be recovered by a control-plane read endpoint.
CREATE TABLE "audit_destination" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "encrypted_endpoint" bytea NOT NULL,
  "encrypted_secret" bytea,
  "dek_id" text NOT NULL REFERENCES "data_encryption_key"("id"),
  "status" text NOT NULL DEFAULT 'configured',
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "audit_destination_kind_chk" CHECK ("kind" IN ('webhook','siem')),
  CONSTRAINT "audit_destination_status_chk" CHECK ("status" IN ('configured','disabled'))
);--> statement-breakpoint
CREATE INDEX "audit_destination_workspace_idx" ON "audit_destination" ("workspace_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "audit_destination" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_destination" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_destination_rls" ON "audit_destination"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_destination" TO manifold_app;
