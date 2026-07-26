-- Internal RFC 8628-shaped CLI device authorization. The verification URI is server-derived;
-- caller supplied client identifiers are accepted only from the control-plane allowlist.
-- forward-fix: expire or deny unsafe pending grants, then correct durable authorization state additively.
ALTER TABLE "cli_authorization"
  ADD COLUMN "client_id" text,
  ADD COLUMN "client_name" text,
  ADD COLUMN "verification_origin" text,
  ADD COLUMN "approved_at" timestamp with time zone,
  ADD COLUMN "denied_by" text REFERENCES "member"("id"),
  ADD COLUMN "denied_at" timestamp with time zone,
  ADD COLUMN "last_polled_at" timestamp with time zone,
  ADD COLUMN "poll_not_before" timestamp with time zone;
--> statement-breakpoint
-- Legacy rows lacked the bindings required for a safe approval. Retire them rather than inventing
-- client/origin facts; callers must start a fresh, reviewable authorization.
UPDATE "cli_authorization"
  SET client_id = COALESCE(client_id, 'legacy-untrusted'),
      client_name = COALESCE(client_name, 'Legacy untrusted authorization'),
      verification_origin = COALESCE(verification_origin, 'https://invalid.local'),
      poll_not_before = COALESCE(poll_not_before, now()),
      status = CASE WHEN status IN ('pending','approved') THEN 'expired' ELSE status END
  WHERE client_id IS NULL OR client_name IS NULL OR verification_origin IS NULL OR poll_not_before IS NULL;
--> statement-breakpoint
ALTER TABLE "cli_authorization"
  ALTER COLUMN "client_id" SET NOT NULL,
  ALTER COLUMN "client_name" SET NOT NULL,
  ALTER COLUMN "verification_origin" SET NOT NULL,
  ALTER COLUMN "poll_not_before" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "cli_authorization_pending_review_idx"
  ON "cli_authorization" ("workspace_id", "status", "expires_at", "created_at" DESC);
--> statement-breakpoint

-- Pre-auth device polling resolves a workspace only by an exact, HMACed device code. This is the
-- same narrowly scoped RLS carve-out as auth_lookup_token: it cannot enumerate grants.
CREATE OR REPLACE FUNCTION auth_lookup_cli_authorization(p_hash bytea)
RETURNS TABLE(
  id text, workspace_id text, status text, scopes jsonb, client_id text, client_name text,
  verification_origin text, interval_seconds int, expires_at timestamptz, poll_not_before timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.workspace_id, c.status, c.scopes, c.client_id, c.client_name, c.verification_origin,
         c.interval_seconds, c.expires_at, c.poll_not_before
  FROM cli_authorization AS c
  WHERE c.device_code_hash = p_hash
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION auth_lookup_cli_authorization(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_cli_authorization(bytea) TO manifold_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_lookup_workspace_slug(p_slug text)
RETURNS TABLE(id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id FROM workspace AS w WHERE w.slug = p_slug LIMIT 1
$$;
REVOKE ALL ON FUNCTION auth_lookup_workspace_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_workspace_slug(text) TO manifold_app;
