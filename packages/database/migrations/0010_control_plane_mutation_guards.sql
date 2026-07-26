-- Durable Idempotency-Key response replay and bounded per-principal mutation limits (SPEC §10.1).
-- forward-fix: retain replay records and add corrective constraints or columns in a subsequent migration.
-- `mutation_idempotency` is deliberately workspace scoped: an idempotency key is never a
-- cross-tenant capability. Actor kind + id distinguish a browser member from an API token.
CREATE TABLE "mutation_idempotency" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "actor_kind" text NOT NULL,
  "actor_id" text NOT NULL,
  "method" text NOT NULL,
  "canonical_path" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "state" text NOT NULL DEFAULT 'in_progress',
  "lease_expires_at" timestamp with time zone NOT NULL,
  "response_status" integer,
  "response_headers" jsonb,
  "response_body" bytea,
  "completed_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mutation_idempotency_state_chk" CHECK ("state" IN ('in_progress','completed')),
  CONSTRAINT "mutation_idempotency_completed_response_chk" CHECK (
    ("state" = 'in_progress' AND "response_status" IS NULL AND "response_headers" IS NULL AND "response_body" IS NULL AND "completed_at" IS NULL)
    OR
    ("state" = 'completed' AND "response_status" IS NOT NULL AND "response_headers" IS NOT NULL AND "response_body" IS NOT NULL AND "completed_at" IS NOT NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "mutation_idempotency_identity_uq" ON "mutation_idempotency"
  ("workspace_id","actor_kind","actor_id","method","canonical_path","idempotency_key");--> statement-breakpoint
CREATE INDEX "mutation_idempotency_expiry_idx" ON "mutation_idempotency" ("workspace_id","expires_at");--> statement-breakpoint

CREATE TABLE "mutation_rate_limit_bucket" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "actor_kind" text NOT NULL,
  "actor_id" text NOT NULL,
  "bucket_start" timestamp with time zone NOT NULL,
  "request_count" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id","actor_kind","actor_id","bucket_start"),
  CONSTRAINT "mutation_rate_limit_count_chk" CHECK ("request_count" >= 0),
  CONSTRAINT "mutation_rate_limit_expiry_chk" CHECK ("expires_at" > "bucket_start")
);--> statement-breakpoint
CREATE INDEX "mutation_rate_limit_expiry_idx" ON "mutation_rate_limit_bucket" ("workspace_id","expires_at");--> statement-breakpoint

ALTER TABLE "mutation_idempotency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mutation_idempotency" FORCE ROW LEVEL SECURITY;
CREATE POLICY "mutation_idempotency_rls" ON "mutation_idempotency"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
ALTER TABLE "mutation_rate_limit_bucket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mutation_rate_limit_bucket" FORCE ROW LEVEL SECURITY;
CREATE POLICY "mutation_rate_limit_bucket_rls" ON "mutation_rate_limit_bucket"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "mutation_idempotency" TO manifold_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mutation_rate_limit_bucket" TO manifold_app;
