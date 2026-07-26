-- Installation identity authentication for config boot fallback and heartbeat.
-- These two SECURITY DEFINER functions are deliberately the only pre-workspace RLS seams:
-- a request must resolve its installation before it can know which workspace GUC to set.
-- forward-fix: rotate affected installation credentials and replace functions through a later migration.

CREATE TABLE "installation_auth_nonce" (
  "installation_id" text NOT NULL REFERENCES "gateway_installation"("id") ON DELETE CASCADE,
  "nonce_hash" bytea NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("installation_id", "nonce_hash"),
  CONSTRAINT "installation_auth_nonce_expiry_chk" CHECK ("expires_at" > "created_at")
);--> statement-breakpoint
CREATE INDEX "installation_auth_nonce_expiry_idx" ON "installation_auth_nonce" ("expires_at");--> statement-breakpoint

ALTER TABLE "installation_auth_nonce" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installation_auth_nonce" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "installation_auth_nonce_rls" ON "installation_auth_nonce"
  USING (EXISTS (SELECT 1 FROM gateway_installation i WHERE i.id = installation_auth_nonce.installation_id AND i.workspace_id = current_setting('manifold.workspace_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM gateway_installation i WHERE i.id = installation_auth_nonce.installation_id AND i.workspace_id = current_setting('manifold.workspace_id', true)));--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_lookup_installation(p_installation_id text)
RETURNS TABLE (
  id text,
  workspace_id text,
  public_key bytea,
  workload_identity jsonb,
  disabled_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, workspace_id, public_key, workload_identity, disabled_at
  FROM gateway_installation
  WHERE id = p_installation_id
  LIMIT 1;
$$;--> statement-breakpoint

-- Atomically claims a nonce under the resolved installation identity. The fixed expiry is
-- supplied by the application after it has enforced timestamp skew; duplicate claims return
-- false even across isolates.
CREATE OR REPLACE FUNCTION auth_claim_installation_nonce(
  p_installation_id text,
  p_nonce_hash bytea,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM installation_auth_nonce WHERE expires_at <= now();
  INSERT INTO installation_auth_nonce (installation_id, nonce_hash, expires_at)
  VALUES (p_installation_id, p_nonce_hash, p_expires_at)
  ON CONFLICT (installation_id, nonce_hash) DO NOTHING;
  RETURN FOUND;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_lookup_installation(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_claim_installation_nonce(text, bytea, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_installation(text) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_claim_installation_nonce(text, bytea, timestamptz) TO manifold_app;--> statement-breakpoint
