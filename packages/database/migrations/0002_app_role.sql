-- ===========================================================================
-- 0002_app_role.sql — run the control plane as a NON-superuser so RLS is load-bearing
--   (SPEC §6.16 / §15.2). SECURITY FIX.
--
-- The control plane previously connected as `postgres` (SUPERUSER). A superuser (and any
-- role with BYPASSRLS) is EXEMPT from row-level security, so every per-workspace policy
-- created in 0001_partitions.sql was inert at runtime — the RLS backstop existed on paper
-- only. This migration creates a least-privilege LOGIN role `manifold_app` that RLS DOES
-- apply to, and carves out the ONE cross-tenant read auth needs.
--
-- ---------------------------------------------------------------------------
-- PASSWORD (placeholder): the literal 'CHANGEME_APP_PASSWORD' below is a PLACEHOLDER only.
-- Replace it per-environment — either edit this line before applying, or run
--   ALTER ROLE manifold_app PASSWORD '<real-secret>';
-- after applying. The app connects with it via
--   DATABASE_URL=postgresql://manifold_app:<password>@<host>:<port>/<db>
-- The password never appears in application code; it lives only in the connection string.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Least-privilege LOGIN role. Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'manifold_app') THEN
		CREATE ROLE manifold_app LOGIN PASSWORD 'CHANGEME_APP_PASSWORD';
	END IF;
END$$;--> statement-breakpoint

-- Defensive: guarantee the role can never bypass RLS even if a prior run created it
-- differently. NOSUPERUSER + NOBYPASSRLS are the two attributes that would make RLS inert;
-- NOCREATEROLE/NOCREATEDB keep the blast radius small.
ALTER ROLE manifold_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Grants. Schema usage + DML on tenant tables (RLS then scopes the rows the app may
--    actually touch) + sequence access. ALTER DEFAULT PRIVILEGES covers tables the migration
--    owner (postgres) creates later (e.g. new monthly partitions).
--
--    GLOBAL/REFERENCE tables are the exception: canonical_model, provider_model_offering,
--    provider_price_revision and registry_field_evidence carry no RLS (they are cross-tenant,
--    §6.4) and are the pricing/catalog source of truth. The app role must NOT be able to write
--    them — otherwise a compromised gateway could forge a provider_price_revision and rewrite
--    money. Catalog ingestion/seeding runs as the migration owner (postgres), never as the
--    tenant-facing app role, so the app role gets SELECT-only on these tables. We grant the
--    blanket DML (which also covers every partition + future partition) then REVOKE write on
--    the four reference tables, leaving their SELECT intact.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO manifold_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO manifold_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON
	canonical_model, provider_model_offering, provider_price_revision, registry_field_evidence
	FROM manifold_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO manifold_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO manifold_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO manifold_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Auth carve-out — chosen option (a): SECURITY DEFINER functions.
--
-- WHY (a) and not an RLS policy (b): token→workspace resolution is inherently cross-tenant.
-- auth.ts HMACs the presented bearer token and looks it up by keyed_hash BEFORE it knows the
-- tenant, so no `manifold.workspace_id` GUC can be set yet. Under RLS + an unset GUC a direct
-- SELECT returns 0 rows and EVERY valid token 401s. A permissive RLS policy (option b) would
-- have to allow reading ANY api_token row whenever the GUC is unset — that both widens the
-- policy surface on the most sensitive table and leaks token rows to any code path that forgot
-- to set the GUC. A SECURITY DEFINER function is a tighter, auditable seam: it runs with the
-- OWNER's privileges (postgres, which has BYPASSRLS), exposes EXACTLY one operation — "fetch one
-- api_token row by exact hash" — cannot enumerate or list, and is the only privileged surface
-- granted to the app. Everything else stays fully workspace-scoped under RLS.
--
-- Owned by the role executing this migration (postgres). `SET search_path = public` pins name
-- resolution so the definer body can't be hijacked by a caller-controlled search_path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_token(p_hash bytea)
RETURNS TABLE (
	id text,
	workspace_id text,
	scopes jsonb,
	revoked_at timestamptz,
	expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
	SELECT id, workspace_id, scopes, revoked_at, expires_at
	FROM api_token
	WHERE keyed_hash = p_hash
	LIMIT 1;
$$;--> statement-breakpoint

-- Best-effort last_used_at touch (was a fire-and-forget UPDATE in auth.ts; that UPDATE would
-- silently match 0 rows under RLS with the GUC unset). Same narrow definer seam: touch exactly
-- one token row by id. Kept separate from the lookup so a SELECT stays a SELECT.
CREATE OR REPLACE FUNCTION auth_touch_token(p_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
	UPDATE api_token SET last_used_at = now() WHERE id = p_id;
$$;--> statement-breakpoint

-- Lock the functions down: revoke the implicit PUBLIC EXECUTE, then grant only to the app role.
REVOKE ALL ON FUNCTION auth_lookup_token(bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_touch_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_token(bytea) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_touch_token(text) TO manifold_app;--> statement-breakpoint
