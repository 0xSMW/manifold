-- Replay responses that contain copy-once credentials must never be retained as ordinary bytea.
-- forward-fix: expire unsafe replay rows and migrate replacement encrypted state without exposing plaintext.
ALTER TABLE "mutation_idempotency"
  ADD COLUMN "response_body_encrypted" bytea,
  ADD COLUMN "response_body_iv" bytea,
  ADD COLUMN "response_body_tag" bytea;
--> statement-breakpoint
ALTER TABLE "mutation_idempotency"
  DROP CONSTRAINT "mutation_idempotency_completed_response_chk";
--> statement-breakpoint
ALTER TABLE "mutation_idempotency"
  ADD CONSTRAINT "mutation_idempotency_completed_response_chk" CHECK (
    ("state" = 'in_progress' AND "response_status" IS NULL AND "response_headers" IS NULL
      AND "response_body" IS NULL AND "response_body_encrypted" IS NULL
      AND "response_body_iv" IS NULL AND "response_body_tag" IS NULL AND "completed_at" IS NULL)
    OR
    ("state" = 'completed' AND "response_status" IS NOT NULL AND "response_headers" IS NOT NULL
      AND (("response_body" IS NOT NULL AND "response_body_encrypted" IS NULL
        AND "response_body_iv" IS NULL AND "response_body_tag" IS NULL)
       OR ("response_body" IS NULL AND "response_body_encrypted" IS NOT NULL
        AND octet_length("response_body_iv") = 12 AND octet_length("response_body_tag") = 16))
      AND "completed_at" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "mutation_rate_limit_bucket" ADD COLUMN "route_identity" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "mutation_rate_limit_bucket" DROP CONSTRAINT "mutation_rate_limit_bucket_pkey";
--> statement-breakpoint
ALTER TABLE "mutation_rate_limit_bucket"
  ADD PRIMARY KEY ("workspace_id", "actor_kind", "actor_id", "route_identity", "bucket_start");
--> statement-breakpoint
-- Config publication is authoritative in this ledger. The value is principal+route bound.
ALTER TABLE "config_operation" ADD COLUMN "mutation_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "config_operation_mutation_key_uq"
  ON "config_operation" ("workspace_id", "mutation_key")
  WHERE "mutation_key" IS NOT NULL;
