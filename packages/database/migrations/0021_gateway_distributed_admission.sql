-- Fleet-wide gateway admission state. These tables are deliberately mutable
-- operational state, separate from the append-only request/job ledgers.
-- forward-fix: reconcile mutable admission state with a later migration; preserve immutable ledgers.
CREATE TABLE "gateway_rate_limit_state" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "installation_id" text NOT NULL REFERENCES "gateway_installation"("id"),
  "virtual_key_id" text NOT NULL REFERENCES "virtual_key"("id"),
  "config_fingerprint" text NOT NULL,
  "request_tokens" double precision NOT NULL,
  "token_tokens" double precision NOT NULL,
  "refilled_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("installation_id", "virtual_key_id"),
  CONSTRAINT "gateway_rate_limit_state_tokens_finite_nonneg_chk" CHECK (
    "request_tokens" >= 0
    AND "request_tokens" <> 'NaN'::double precision
    AND "request_tokens" <> 'Infinity'::double precision
    AND "request_tokens" <> '-Infinity'::double precision
    AND "token_tokens" >= 0
    AND "token_tokens" <> 'NaN'::double precision
    AND "token_tokens" <> 'Infinity'::double precision
    AND "token_tokens" <> '-Infinity'::double precision
  )
);--> statement-breakpoint

CREATE TABLE "gateway_concurrency_lease" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "installation_id" text NOT NULL REFERENCES "gateway_installation"("id"),
  "virtual_key_id" text NOT NULL REFERENCES "virtual_key"("id"),
  "state" text NOT NULL DEFAULT 'active',
  "expires_at" timestamp with time zone NOT NULL,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "gateway_concurrency_lease_state_chk" CHECK ("state" IN ('active','released','expired')),
  CONSTRAINT "gateway_concurrency_lease_release_state_chk" CHECK (
    ("state" = 'released') = ("released_at" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX "gateway_concurrency_lease_active_installation_expiry_idx"
  ON "gateway_concurrency_lease" ("installation_id", "expires_at")
  WHERE "state" = 'active';--> statement-breakpoint
CREATE INDEX "gateway_concurrency_lease_active_key_expiry_idx"
  ON "gateway_concurrency_lease" ("installation_id", "virtual_key_id", "expires_at")
  WHERE "state" = 'active';--> statement-breakpoint

ALTER TABLE "gateway_rate_limit_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gateway_rate_limit_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "gateway_rate_limit_state_rls" ON "gateway_rate_limit_state"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
ALTER TABLE "gateway_concurrency_lease" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gateway_concurrency_lease" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "gateway_concurrency_lease_rls" ON "gateway_concurrency_lease"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "gateway_rate_limit_state" TO manifold_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gateway_concurrency_lease" TO manifold_app;
