-- ===========================================================================
-- 0032_human_auth.sql — first-party human identity, credentials, invitations,
-- and session/token subject metadata.
-- forward-fix: preserve legacy member/token/session rows; repair a bad human-auth
-- record by revoking it or issuing a successor credential, never by restoring
-- plaintext secrets or weakening the hash/RLS boundaries.
-- ===========================================================================

-- Global identity is intentionally separate from tenant membership.  The app
-- role receives no direct access: authentication is only possible through the
-- narrow SECURITY DEFINER operations below.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint

CREATE TABLE "auth_user" (
  "id" text PRIMARY KEY NOT NULL,
  "email" citext NOT NULL,
  "name" text,
  "email_verified_at" timestamp with time zone,
  "disabled_at" timestamp with time zone,
  "session_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "auth_user_session_version_chk" CHECK ("session_version" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_email_uq" ON "auth_user" ("email");--> statement-breakpoint

CREATE TABLE "password_credential" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE,
  "password_hash" text NOT NULL,
  "changed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "locked_until" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "password_credential_failed_attempts_chk" CHECK ("failed_attempts" >= 0)
);--> statement-breakpoint

CREATE TABLE "auth_email_token" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "email" citext NOT NULL,
  "keyed_hash" bytea NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "auth_email_token_purpose_chk" CHECK ("purpose" IN ('activation','password_reset'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_token_hash_uq" ON "auth_email_token" ("keyed_hash");--> statement-breakpoint
CREATE INDEX "auth_email_token_user_purpose_idx" ON "auth_email_token" ("user_id","purpose","expires_at");--> statement-breakpoint

-- HMAC-keyed values are used so neither IP addresses nor email addresses are
-- retained in the unauthenticated rate-limiter.
CREATE TABLE "auth_rate_limit_bucket" (
  "kind" text NOT NULL,
  "subject_hash" bytea NOT NULL,
  "bucket_start" timestamp with time zone NOT NULL,
  "request_count" integer NOT NULL DEFAULT 1,
  "expires_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("kind","subject_hash","bucket_start"),
  CONSTRAINT "auth_rate_limit_bucket_count_chk" CHECK ("request_count" >= 1)
);--> statement-breakpoint
CREATE INDEX "auth_rate_limit_bucket_expiry_idx" ON "auth_rate_limit_bucket" ("expires_at");--> statement-breakpoint

ALTER TABLE "member"
  ADD COLUMN "user_id" text REFERENCES "auth_user"("id"),
  ADD COLUMN "invited_at" timestamp with time zone,
  ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
-- Pre-human-auth members are already admitted workspace records.  Do not merge
-- them by email until the owner proves control of that address during activation.
UPDATE "member" SET "accepted_at" = "created_at" WHERE "accepted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "member_user_workspace_idx" ON "member" ("user_id","workspace_id");--> statement-breakpoint
-- A control-plane database is authoritative for one workspace, so an interactive
-- user can bind to at most one local membership.  Legacy seed rows remain NULL.
CREATE UNIQUE INDEX "member_user_uq" ON "member" ("user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "workspace_invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "member_id" text NOT NULL REFERENCES "member"("id") ON DELETE CASCADE,
  "email" citext NOT NULL,
  "role" text NOT NULL,
  "invited_by" text REFERENCES "member"("id"),
  "keyed_hash" bytea NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_invitation_role_chk" CHECK ("role" IN ('owner','admin','editor','viewer','billing'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitation_hash_uq" ON "workspace_invitation" ("keyed_hash");--> statement-breakpoint
CREATE INDEX "workspace_invitation_workspace_email_idx" ON "workspace_invitation" ("workspace_id","email","expires_at");--> statement-breakpoint

CREATE TABLE "service_account" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "name" text NOT NULL,
  "description" text,
  "created_by" text REFERENCES "member"("id"),
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_account_name_uq" ON "service_account" ("workspace_id","name");--> statement-breakpoint

ALTER TABLE "api_token"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'legacy',
  ADD COLUMN "label" text,
  ADD COLUMN "user_id" text REFERENCES "auth_user"("id"),
  ADD COLUMN "service_account_id" text REFERENCES "service_account"("id");--> statement-breakpoint
ALTER TABLE "api_token"
  ADD CONSTRAINT "api_token_kind_chk" CHECK ("kind" IN ('legacy','personal','service')),
  ADD CONSTRAINT "api_token_subject_chk" CHECK (
    ("kind" = 'legacy' AND "user_id" IS NULL AND "service_account_id" IS NULL)
    OR ("kind" = 'personal' AND "user_id" IS NOT NULL AND "service_account_id" IS NULL)
    OR ("kind" = 'service' AND "user_id" IS NULL AND "service_account_id" IS NOT NULL)
  );--> statement-breakpoint
CREATE INDEX "api_token_user_workspace_idx" ON "api_token" ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "api_token_service_account_idx" ON "api_token" ("service_account_id");--> statement-breakpoint

-- Nullable additions preserve all opaque browser sessions issued before this
-- migration.  New human sessions bind both user session-version and CSRF hash.
ALTER TABLE "console_session"
  ADD COLUMN "user_id" text REFERENCES "auth_user"("id"),
  ADD COLUMN "csrf_hash" bytea,
  ADD COLUMN "session_version" integer,
  ADD COLUMN "user_agent" text,
  ADD COLUMN "ip_hash" bytea;--> statement-breakpoint
ALTER TABLE "console_session"
  ADD CONSTRAINT "console_session_version_chk" CHECK ("session_version" IS NULL OR "session_version" >= 1);--> statement-breakpoint
CREATE INDEX "console_session_user_idx" ON "console_session" ("user_id","workspace_id");--> statement-breakpoint

-- Tenant tables retain the standard workspace GUC boundary.  Global auth
-- tables deliberately have no tenant RLS policy and are inaccessible directly.
ALTER TABLE "workspace_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_invitation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_invitation_rls" ON "workspace_invitation"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
ALTER TABLE "service_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "service_account_rls" ON "service_account"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint

REVOKE ALL ON "auth_user", "password_credential", "auth_email_token", "auth_rate_limit_bucket" FROM manifold_app;--> statement-breakpoint

-- Exact-email lookup is the only pre-workspace password seam.  It intentionally
-- returns one candidate only; callers must still use a dummy Argon2id verify to
-- make unknown-address timing indistinguishable.
CREATE FUNCTION "auth_lookup_password_login"(p_email citext)
RETURNS TABLE (
  user_id text,
  email citext,
  password_hash text,
  user_disabled_at timestamptz,
  email_verified_at timestamptz,
  locked_until timestamptz,
  failed_attempts integer,
  session_version integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, c.password_hash, u.disabled_at, u.email_verified_at,
         c.locked_until, c.failed_attempts, u.session_version
  FROM auth_user AS u
  JOIN password_credential AS c ON c.user_id = u.id
  WHERE u.email = p_email
  LIMIT 1;
$$;--> statement-breakpoint

-- Consume is an exact-HMAC, one-time capability operation.  It neither lists
-- tokens nor permits a caller to choose another user's record.
CREATE FUNCTION "auth_redeem_email_token"(p_hash bytea, p_purpose text)
RETURNS TABLE (user_id text, email citext)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE auth_email_token
  SET consumed_at = now()
  WHERE keyed_hash = p_hash
    AND purpose = p_purpose
    AND consumed_at IS NULL
    AND expires_at > now()
  RETURNING auth_email_token.user_id, auth_email_token.email;
$$;--> statement-breakpoint

-- Atomic global rate-limit increment.  The HMAC input is supplied by the app;
-- this function exposes only the post-charge count and never any subject data.
CREATE FUNCTION "auth_charge_rate_limit"(p_kind text, p_subject_hash bytea, p_bucket_start timestamptz, p_expires_at timestamptz, p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_count integer;
BEGIN
  IF p_kind = '' OR p_limit < 1 OR p_expires_at <= p_bucket_start THEN
    RAISE EXCEPTION 'invalid auth rate-limit parameters';
  END IF;
  INSERT INTO auth_rate_limit_bucket(kind, subject_hash, bucket_start, request_count, expires_at)
  VALUES (p_kind, p_subject_hash, p_bucket_start, 1, p_expires_at)
  ON CONFLICT (kind, subject_hash, bucket_start) DO UPDATE
    SET request_count = auth_rate_limit_bucket.request_count + 1
    WHERE auth_rate_limit_bucket.request_count < p_limit
  RETURNING request_count INTO v_count;
  RETURN v_count;
END;
$function$;--> statement-breakpoint

-- Existing functions are replaced with supersets so old SELECT lists remain
-- valid while new application code can enforce user/member/service status.
DROP FUNCTION "auth_lookup_token"(bytea);--> statement-breakpoint
CREATE FUNCTION "auth_lookup_token"(p_hash bytea)
RETURNS TABLE (
  id text, workspace_id text, scopes jsonb, revoked_at timestamptz, expires_at timestamptz,
  token_kind text, token_user_id text, service_account_id text,
  member_role text, member_accepted_at timestamptz, member_disabled_at timestamptz,
  user_disabled_at timestamptz, service_account_disabled_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.workspace_id, t.scopes, t.revoked_at, t.expires_at,
         t.kind, t.user_id, t.service_account_id,
         m.role, m.accepted_at, m.disabled_at, u.disabled_at, sa.disabled_at
  FROM api_token AS t
  LEFT JOIN member AS m ON m.id = t.created_by AND m.workspace_id = t.workspace_id
  LEFT JOIN auth_user AS u ON u.id = t.user_id
  LEFT JOIN service_account AS sa ON sa.id = t.service_account_id AND sa.workspace_id = t.workspace_id
  WHERE t.keyed_hash = p_hash
  LIMIT 1;
$$;--> statement-breakpoint

DROP FUNCTION "auth_lookup_console_session"(bytea);--> statement-breakpoint
CREATE FUNCTION "auth_lookup_console_session"(p_hash bytea)
RETURNS TABLE (
  id text, workspace_id text, member_id text, member_email citext, member_name text,
  member_role text, member_disabled_at timestamptz, member_accepted_at timestamptz,
  user_id text, user_disabled_at timestamptz, user_email_verified_at timestamptz, user_session_version integer,
  session_version integer, csrf_hash bytea, scopes jsonb, expires_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.workspace_id, s.member_id, m.email, m.name, m.role, m.disabled_at,
         m.accepted_at, s.user_id, u.disabled_at, u.email_verified_at, u.session_version, s.session_version,
         s.csrf_hash, s.scopes, s.expires_at, s.revoked_at
  FROM console_session AS s
  JOIN member AS m ON m.id = s.member_id AND m.workspace_id = s.workspace_id
  LEFT JOIN auth_user AS u ON u.id = s.user_id
  WHERE s.keyed_hash = p_hash
  LIMIT 1;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "auth_lookup_password_login"(citext) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_redeem_email_token"(bytea,text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_charge_rate_limit"(text,bytea,timestamptz,timestamptz,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_lookup_token"(bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_lookup_console_session"(bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_lookup_password_login"(citext) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_redeem_email_token"(bytea,text) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_charge_rate_limit"(text,bytea,timestamptz,timestamptz,integer) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_lookup_token"(bytea) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_lookup_console_session"(bytea) TO manifold_app;

-- Auth mutations run before an interactive principal exists.  This narrow
-- append helper produces the same v1 sealed audit-chain payload as lib/audit.ts
-- while deliberately accepting no detail payload (credentials must never enter
-- audit storage).  The caller supplies only fixed internal action/target facts.
CREATE FUNCTION "auth_append_human_audit"(
  p_workspace_id text, p_actor_kind text, p_actor_id text, p_action text, p_target_kind text, p_target_id text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_id text; v_created_at timestamptz; v_created_json text; v_sequence bigint;
  v_previous bytea; v_previous_hex text; v_payload text; v_hash bytea;
BEGIN
  IF p_workspace_id = '' OR p_actor_kind = '' OR p_action = '' OR p_target_kind = '' OR p_target_id = '' THEN
    RAISE EXCEPTION 'invalid auth audit parameters';
  END IF;
  -- audit_event is FORCE RLS; lifecycle calls happen before a workspace-scoped
  -- request exists, so establish only the resolved target workspace locally.
  PERFORM set_config('manifold.workspace_id', p_workspace_id, true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id, 0));
  v_created_at := date_trunc('milliseconds', clock_timestamp());
  SELECT e.chain_sequence, encode(e.chain_hash, 'hex') INTO v_sequence, v_previous_hex
    FROM audit_event AS e WHERE e.workspace_id = p_workspace_id AND e.chain_version = 1
    ORDER BY e.chain_sequence DESC LIMIT 1;
  v_sequence := COALESCE(v_sequence, 0) + 1;
  v_previous := CASE WHEN v_previous_hex IS NULL THEN NULL ELSE decode(v_previous_hex, 'hex') END;
  v_id := 'aud_' || encode(gen_random_bytes(16), 'hex');
  v_created_json := to_json(to_char(v_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
  v_payload := '{"action":' || to_json(p_action)::text || ',"actorId":' || to_json(p_actor_id)::text
    || ',"actorKind":' || to_json(p_actor_kind)::text || ',"afterHash":null,"beforeHash":null,"chainSequence":'
    || to_json(v_sequence::text)::text || ',"createdAt":' || v_created_json || ',"detail":null,"id":'
    || to_json(v_id)::text || ',"prevChainHash":' || COALESCE(to_json(v_previous_hex)::text, 'null') || ',"requestRef":null,"targetId":'
    || to_json(p_target_id)::text || ',"targetKind":' || to_json(p_target_kind)::text || ',"workspaceId":'
    || to_json(p_workspace_id)::text || '}';
  v_hash := digest(v_payload, 'sha256');
  INSERT INTO audit_event (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id,
    chain_version, chain_sequence, prev_chain_hash, chain_hash, chain_sealed_at, created_at)
  VALUES (v_id, p_workspace_id, p_actor_kind, p_actor_id, p_action, p_target_kind, p_target_id,
    1, v_sequence, v_previous, v_hash, v_created_at, v_created_at);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_append_human_audit"(text,text,text,text,text,text) FROM PUBLIC;--> statement-breakpoint

-- Exact workspace/member proof for privileged flows (notably CLI approval).
-- A missing row is fail-closed; callers never need SELECT on auth_user.
CREATE FUNCTION "auth_lookup_verified_member"(p_workspace_id text, p_member_id text)
RETURNS TABLE (session_version integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.session_version
  FROM member AS m
  JOIN auth_user AS u ON u.id = m.user_id
  WHERE m.workspace_id = p_workspace_id
    AND m.id = p_member_id
    AND m.disabled_at IS NULL
    AND m.accepted_at IS NOT NULL
    AND u.disabled_at IS NULL
    AND u.email_verified_at IS NOT NULL
  LIMIT 1;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_lookup_verified_member"(text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_lookup_verified_member"(text,text) TO manifold_app;

-- The remainder of the human lifecycle is intentionally implemented inside
-- narrowly shaped definer functions: manifold_app cannot read or write global
-- identity rows directly.  All IDs are resolved from a proved email or opaque
-- capability, never from caller-supplied workspace/member identifiers.

CREATE FUNCTION "auth_initial_activation_status"()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth_user AS u
    JOIN member AS m ON m.user_id = u.id
    WHERE u.email_verified_at IS NOT NULL
      AND u.disabled_at IS NULL
      AND m.role = 'owner'
      AND m.disabled_at IS NULL
      AND m.accepted_at IS NOT NULL
  );
$$;--> statement-breakpoint

CREATE FUNCTION "auth_prepare_initial_activation"(
  p_email citext, p_user_id text, p_token_id text, p_hash bytea, p_expires_at timestamptz
)
RETURNS TABLE (email citext, workspace_id text, workspace_name text, member_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_owner record; v_user_id text; v_owner_count integer;
BEGIN
  IF p_email IS NULL OR p_user_id = '' OR p_token_id = '' OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid initial activation parameters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('manifold_initial_activation'));
  SELECT count(*) INTO v_owner_count FROM member AS m
    WHERE m.role = 'owner' AND m.disabled_at IS NULL;
  IF v_owner_count <> 1 THEN
    RAISE EXCEPTION 'initial activation requires exactly one enabled owner';
  END IF;
  SELECT m.id, m.workspace_id, w.name, m.email INTO v_owner
    FROM member AS m JOIN workspace AS w ON w.id = m.workspace_id
    WHERE m.role = 'owner' AND m.disabled_at IS NULL
    FOR UPDATE OF m;
  IF v_owner.email <> p_email THEN
    RAISE EXCEPTION 'initial activation email is not the enabled owner';
  END IF;
  SELECT u.id INTO v_user_id FROM auth_user AS u WHERE u.email = p_email FOR UPDATE;
  IF FOUND AND EXISTS (SELECT 1 FROM auth_user AS u WHERE u.id = v_user_id AND u.email_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'initial activation is already complete';
  END IF;
  IF NOT FOUND THEN
    INSERT INTO auth_user(id, email) VALUES (p_user_id, p_email) RETURNING id INTO v_user_id;
  END IF;
  UPDATE member AS m SET user_id = v_user_id, invited_at = COALESCE(m.invited_at, now()), accepted_at = NULL, updated_at = now()
    WHERE m.id = v_owner.id;
  UPDATE auth_email_token AS t SET consumed_at = now()
    WHERE t.user_id = v_user_id AND t.purpose = 'activation' AND t.consumed_at IS NULL;
  INSERT INTO auth_email_token(id, user_id, purpose, email, keyed_hash, expires_at)
    VALUES (p_token_id, v_user_id, 'activation', p_email, p_hash, p_expires_at);
  RETURN QUERY SELECT v_owner.email, v_owner.workspace_id, v_owner.name, v_owner.id;
END;
$function$;--> statement-breakpoint

CREATE FUNCTION "auth_complete_activation"(p_hash bytea, p_name text, p_password_hash text)
RETURNS TABLE (user_id text, member_id text, workspace_id text, email citext, name text, role text, session_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_token record; v_member record; v_name text;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' OR p_password_hash !~ '^\$argon2id\$' THEN
    RAISE EXCEPTION 'invalid activation completion parameters';
  END IF;
  SELECT t.user_id, t.email INTO v_token FROM auth_email_token AS t
    WHERE t.keyed_hash = p_hash AND t.purpose = 'activation' AND t.consumed_at IS NULL AND t.expires_at > now()
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT m.id, m.workspace_id, m.role, m.disabled_at INTO v_member FROM member AS m
    WHERE m.user_id = v_token.user_id FOR UPDATE;
  IF NOT FOUND OR v_member.disabled_at IS NOT NULL THEN RAISE EXCEPTION 'activation membership unavailable'; END IF;
  v_name := btrim(p_name);
  UPDATE auth_email_token AS t SET consumed_at = now() WHERE t.keyed_hash = p_hash AND t.consumed_at IS NULL;
  UPDATE auth_user AS u SET name = v_name, email_verified_at = now(), updated_at = now()
    WHERE u.id = v_token.user_id AND u.disabled_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'activation user unavailable'; END IF;
  INSERT INTO password_credential(user_id, password_hash, changed_at, failed_attempts, locked_until)
    VALUES (v_token.user_id, p_password_hash, now(), 0, NULL)
    ON CONFLICT ON CONSTRAINT password_credential_pkey DO UPDATE SET password_hash = EXCLUDED.password_hash, changed_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now();
  UPDATE member AS m SET name = v_name, accepted_at = now(), updated_at = now() WHERE m.id = v_member.id;
  PERFORM auth_append_human_audit(v_member.workspace_id, 'system', 'human-auth', 'auth.activation.complete', 'auth_user', v_token.user_id);
  RETURN QUERY SELECT u.id, v_member.id, v_member.workspace_id, u.email, v_name, v_member.role, u.session_version
    FROM auth_user AS u WHERE u.id = v_token.user_id;
END;
$function$;--> statement-breakpoint

CREATE FUNCTION "auth_issue_password_reset"(
  p_email citext, p_token_id text, p_hash bytea, p_expires_at timestamptz
)
RETURNS TABLE (email citext)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_user_id text; v_email citext;
BEGIN
  IF p_email IS NULL OR p_token_id = '' OR p_expires_at <= now() THEN RAISE EXCEPTION 'invalid password reset parameters'; END IF;
  SELECT u.id, u.email INTO v_user_id, v_email FROM auth_user AS u
    JOIN member AS m ON m.user_id = u.id
    WHERE u.email = p_email AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL
      AND m.disabled_at IS NULL AND m.accepted_at IS NOT NULL
    FOR UPDATE OF u, m;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE auth_email_token AS t SET consumed_at = now()
    WHERE t.user_id = v_user_id AND t.purpose = 'password_reset' AND t.consumed_at IS NULL;
  INSERT INTO auth_email_token(id, user_id, purpose, email, keyed_hash, expires_at)
    VALUES (p_token_id, v_user_id, 'password_reset', v_email, p_hash, p_expires_at);
  RETURN QUERY SELECT v_email;
END;
$function$;--> statement-breakpoint

CREATE FUNCTION "auth_complete_password_reset"(p_hash bytea, p_password_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_user_id text; v_workspace_id text;
BEGIN
  IF p_password_hash !~ '^\$argon2id\$' THEN RAISE EXCEPTION 'invalid password reset completion parameters'; END IF;
  SELECT t.user_id INTO v_user_id FROM auth_email_token AS t
    WHERE t.keyed_hash = p_hash AND t.purpose = 'password_reset' AND t.consumed_at IS NULL AND t.expires_at > now()
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM auth_user AS u WHERE u.id = v_user_id AND u.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT m.workspace_id INTO v_workspace_id FROM member AS m
    WHERE m.user_id = v_user_id AND m.disabled_at IS NULL AND m.accepted_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE auth_email_token AS t SET consumed_at = now() WHERE t.keyed_hash = p_hash AND t.consumed_at IS NULL;
  INSERT INTO password_credential(user_id, password_hash, changed_at, failed_attempts, locked_until)
    VALUES (v_user_id, p_password_hash, now(), 0, NULL)
    ON CONFLICT ON CONSTRAINT password_credential_pkey DO UPDATE SET password_hash = EXCLUDED.password_hash, changed_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now();
  UPDATE auth_user AS u SET session_version = u.session_version + 1, updated_at = now() WHERE u.id = v_user_id;
  UPDATE console_session AS s SET revoked_at = COALESCE(s.revoked_at, now()) WHERE s.user_id = v_user_id;
  PERFORM auth_append_human_audit(v_workspace_id, 'system', 'human-auth', 'auth.password_reset.complete', 'auth_user', v_user_id);
  RETURN true;
END;
$function$;--> statement-breakpoint

-- Login counters are keyed by normalized email and reveal no account state.
CREATE FUNCTION "auth_record_login_failure"(p_email citext)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  UPDATE password_credential AS c SET
    failed_attempts = c.failed_attempts + 1,
    locked_until = CASE WHEN c.failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE c.locked_until END,
    updated_at = now()
  FROM auth_user AS u
  WHERE c.user_id = u.id AND u.email = p_email;
END;
$function$;--> statement-breakpoint

CREATE FUNCTION "auth_record_login_success"(p_email citext)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE password_credential AS c SET failed_attempts = 0, locked_until = NULL, updated_at = now()
  FROM auth_user AS u WHERE c.user_id = u.id AND u.email = p_email;
$$;--> statement-breakpoint

CREATE FUNCTION "auth_lookup_workspace_invitation"(p_hash bytea)
RETURNS TABLE (email citext, workspace_id text, workspace_name text, member_id text, role text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.email, i.workspace_id, w.name, i.member_id, i.role, i.expires_at
  FROM workspace_invitation AS i JOIN workspace AS w ON w.id = i.workspace_id
  WHERE i.keyed_hash = p_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  LIMIT 1;
$$;--> statement-breakpoint

CREATE FUNCTION "auth_accept_workspace_invitation"(p_hash bytea, p_user_id text, p_name text, p_password_hash text)
RETURNS TABLE (user_id text, member_id text, workspace_id text, email citext, name text, role text, session_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_invite record; v_existing text; v_name text;
BEGIN
  IF p_user_id = '' OR p_name IS NULL OR btrim(p_name) = '' OR p_password_hash !~ '^\$argon2id\$' THEN
    RAISE EXCEPTION 'invalid invitation acceptance parameters';
  END IF;
  SELECT i.id, i.workspace_id, i.member_id, i.email, i.role INTO v_invite FROM workspace_invitation AS i
    WHERE i.keyed_hash = p_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT u.id INTO v_existing FROM auth_user AS u WHERE u.email = v_invite.email FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'invitation user already exists'; END IF;
  PERFORM 1 FROM member AS m WHERE m.id = v_invite.member_id AND m.workspace_id = v_invite.workspace_id
    AND m.email = v_invite.email AND m.disabled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation membership unavailable'; END IF;
  v_name := btrim(p_name);
  INSERT INTO auth_user(id, email, name, email_verified_at) VALUES (p_user_id, v_invite.email, v_name, now());
  INSERT INTO password_credential(user_id, password_hash) VALUES (p_user_id, p_password_hash);
  UPDATE member AS m SET user_id = p_user_id, name = v_name, accepted_at = now(), updated_at = now() WHERE m.id = v_invite.member_id;
  UPDATE workspace_invitation AS i SET accepted_at = now() WHERE i.id = v_invite.id;
  PERFORM auth_append_human_audit(v_invite.workspace_id, 'system', 'human-auth', 'workspace_invitation.accept', 'workspace_invitation', v_invite.id);
  RETURN QUERY SELECT u.id, m.id, m.workspace_id, u.email, u.name, m.role, u.session_version
    FROM auth_user AS u JOIN member AS m ON m.user_id = u.id WHERE u.id = p_user_id;
END;
$function$;--> statement-breakpoint

-- Password lookup gains the deterministic local membership required to issue a
-- browser session without a caller-supplied workspace selector.
DROP FUNCTION "auth_lookup_password_login"(citext);--> statement-breakpoint
CREATE FUNCTION "auth_lookup_password_login"(p_email citext)
RETURNS TABLE (
  user_id text, email citext, password_hash text, user_disabled_at timestamptz,
  email_verified_at timestamptz, locked_until timestamptz, failed_attempts integer,
  session_version integer, workspace_id text, member_id text, member_name text,
  member_role text, member_disabled_at timestamptz, member_accepted_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, c.password_hash, u.disabled_at, u.email_verified_at,
         c.locked_until, c.failed_attempts, u.session_version, m.workspace_id,
         m.id, m.name, m.role, m.disabled_at, m.accepted_at
  FROM auth_user AS u
  JOIN password_credential AS c ON c.user_id = u.id
  JOIN member AS m ON m.user_id = u.id
  WHERE u.email = p_email
  LIMIT 1;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "auth_initial_activation_status"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_prepare_initial_activation"(citext,text,text,bytea,timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_complete_activation"(bytea,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_issue_password_reset"(citext,text,bytea,timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_complete_password_reset"(bytea,text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_record_login_failure"(citext) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_record_login_success"(citext) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_lookup_workspace_invitation"(bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_accept_workspace_invitation"(bytea,text,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_lookup_password_login"(citext) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_initial_activation_status"() TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_prepare_initial_activation"(citext,text,text,bytea,timestamptz) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_complete_activation"(bytea,text,text) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_issue_password_reset"(citext,text,bytea,timestamptz) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_complete_password_reset"(bytea,text) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_record_login_failure"(citext) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_record_login_success"(citext) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_lookup_workspace_invitation"(bytea) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_accept_workspace_invitation"(bytea,text,text,text) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_lookup_password_login"(citext) TO manifold_app;
