-- ===========================================================================
-- 0008_console_sessions.sql — hashed browser-console sessions.
-- forward-fix: revoke affected sessions and ship a follow-up migration; cookie plaintext remains unrecoverable.
--
-- The cookie plaintext is never stored. This table carries only its keyed HMAC,
-- identity, a scope snapshot, and lifecycle timestamps. Token plaintext and token
-- identity are deliberately absent, so a console session cannot disclose or be
-- used to recover the API token that created it.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "console_session" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspace"("id"),
	"member_id" text NOT NULL REFERENCES "member"("id"),
	"keyed_hash" bytea NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "console_session_hash_uq" ON "console_session" ("keyed_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "console_session_member_idx" ON "console_session" ("workspace_id", "member_id");--> statement-breakpoint

-- Session lookup must precede workspace resolution, exactly like api-token
-- lookup. Keep the privileged seam exact-hash-only; all subsequent reads are
-- performed under withWorkspace() and normal RLS.
CREATE OR REPLACE FUNCTION auth_lookup_console_session(p_hash bytea)
RETURNS TABLE (
	id text,
	workspace_id text,
	member_id text,
	member_email citext,
	member_name text,
	member_role text,
	member_disabled_at timestamptz,
	scopes jsonb,
	expires_at timestamptz,
	revoked_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
	SELECT s.id, s.workspace_id, s.member_id, m.email, m.name, m.role,
	       m.disabled_at, s.scopes, s.expires_at, s.revoked_at
	FROM console_session AS s
	JOIN member AS m ON m.id = s.member_id AND m.workspace_id = s.workspace_id
	WHERE s.keyed_hash = p_hash
	LIMIT 1;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_touch_console_session(p_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
	UPDATE console_session SET last_used_at = now() WHERE id = p_id;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_lookup_console_session(bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_touch_console_session(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_console_session(bytea) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_touch_console_session(text) TO manifold_app;--> statement-breakpoint

ALTER TABLE "console_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "console_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "console_session_rls" ON "console_session"
	USING (workspace_id = current_setting('manifold.workspace_id', true));
