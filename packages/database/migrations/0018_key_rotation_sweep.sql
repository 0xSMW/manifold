-- Bounded, tenant-scoped work ledger for expired rotated virtual keys.  A row coalesces
-- multiple expired predecessors for one installation into a single keys-only publication.
-- forward-fix: leave work durable and correct retry or lease behavior in a successor migration.
CREATE TABLE "key_rotation_expiry_publish" (
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "installation_id" text NOT NULL REFERENCES "gateway_installation"("id"),
  "operation_id" text REFERENCES "config_operation"("id"),
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "lease_until" timestamp with time zone,
  "last_error" jsonb,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "installation_id"),
  CONSTRAINT "key_rotation_expiry_publish_status_chk"
    CHECK ("status" IN ('pending', 'processing', 'done'))
);
--> statement-breakpoint
ALTER TABLE "key_rotation_expiry_publish" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "key_rotation_expiry_publish" FORCE ROW LEVEL SECURITY;
CREATE POLICY "key_rotation_expiry_publish_rls" ON "key_rotation_expiry_publish"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));
GRANT SELECT, INSERT, UPDATE ON "key_rotation_expiry_publish" TO manifold_app;
--> statement-breakpoint
CREATE INDEX "key_rotation_expiry_publish_claim_idx"
  ON "key_rotation_expiry_publish" ("workspace_id", "created_at")
  WHERE "status" = 'pending';
--> statement-breakpoint
-- The scheduler discovers tenant IDs only.  All mutation and job claiming remains inside
-- withWorkspace(), so this function is not a cross-tenant data mutation carve-out.
CREATE OR REPLACE FUNCTION "key_rotation_expiry_due_workspaces"(p_limit integer DEFAULT 25)
RETURNS TABLE (workspace_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT due.workspace_id
  FROM (
    SELECT k.workspace_id, min(k.expires_at) AS due_at
    FROM virtual_key k
    WHERE k.successor_key_id IS NOT NULL
      AND k.revoked_at IS NULL
      AND k.expires_at <= now()
    GROUP BY k.workspace_id
    UNION ALL
    SELECT p.workspace_id, min(p.created_at) AS due_at
    FROM key_rotation_expiry_publish p
    WHERE p.status = 'pending'
       OR (p.status = 'processing' AND p.lease_until <= now())
    GROUP BY p.workspace_id
  ) due
  GROUP BY due.workspace_id
  ORDER BY min(due.due_at), due.workspace_id
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;
REVOKE ALL ON FUNCTION "key_rotation_expiry_due_workspaces"(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "key_rotation_expiry_due_workspaces"(integer) TO manifold_app;
