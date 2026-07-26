-- Durable, tenant-scoped audit export queue. Destination ciphertext is intentionally never copied
-- into a job or attempt row: it is unwrapped only by the delivery worker immediately before send.
-- forward-fix: pause delivery and correct queue state additively; retain jobs and immutable audit events.
CREATE TABLE "audit_delivery_job" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "destination_id" text NOT NULL REFERENCES "audit_destination"("id"),
  "audit_event_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "run_after" timestamp with time zone NOT NULL DEFAULT now(),
  "lease_until" timestamp with time zone,
  "last_error_code" text,
  "last_attempt_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "audit_delivery_job_status_chk" CHECK ("status" IN ('pending','processing','delivered','dead','cancelled')),
  CONSTRAINT "audit_delivery_job_attempt_chk" CHECK ("attempt_count" >= 0),
  CONSTRAINT "audit_delivery_job_uq" UNIQUE ("destination_id", "audit_event_id")
);
--> statement-breakpoint
CREATE INDEX "audit_delivery_job_claim_idx" ON "audit_delivery_job" ("workspace_id", "run_after") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE "audit_delivery_attempt" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "job_id" text NOT NULL REFERENCES "audit_delivery_job"("id") ON DELETE CASCADE,
  "attempt_number" integer NOT NULL,
  "outcome" text NOT NULL,
  "status_code" integer,
  "error_code" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "audit_delivery_attempt_outcome_chk" CHECK ("outcome" IN ('delivered','retry','dead')),
  CONSTRAINT "audit_delivery_attempt_uq" UNIQUE ("job_id", "attempt_number")
);
--> statement-breakpoint
ALTER TABLE "audit_delivery_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_delivery_job" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_delivery_job_rls" ON "audit_delivery_job"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));
ALTER TABLE "audit_delivery_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_delivery_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_delivery_attempt_rls" ON "audit_delivery_attempt"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_delivery_job", "audit_delivery_attempt" TO manifold_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enqueue_audit_delivery"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_delivery_job (id, workspace_id, destination_id, audit_event_id)
  SELECT 'adj_' || substr(md5(random()::text || clock_timestamp()::text || d.id || NEW.id), 1, 24),
         NEW.workspace_id, d.id, NEW.id
  FROM audit_destination d
  WHERE d.workspace_id = NEW.workspace_id AND d.status = 'configured' AND d.disabled_at IS NULL
  ON CONFLICT (destination_id, audit_event_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "audit_event_enqueue_delivery"
  AFTER INSERT ON "audit_event" FOR EACH ROW EXECUTE FUNCTION "enqueue_audit_delivery"();
--> statement-breakpoint
-- The scheduler cannot know tenants in advance. This narrowly scoped definer seam exposes only
-- workspace IDs that have due work; each subsequent claim still runs inside its tenant RLS GUC.
CREATE OR REPLACE FUNCTION "audit_delivery_due_workspaces"(p_limit integer DEFAULT 25)
RETURNS TABLE (workspace_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT j.workspace_id
  FROM audit_delivery_job j
  WHERE j.status = 'pending' AND j.run_after <= now()
  GROUP BY j.workspace_id
  ORDER BY min(j.run_after), j.workspace_id
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;
REVOKE ALL ON FUNCTION "audit_delivery_due_workspaces"(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "audit_delivery_due_workspaces"(integer) TO manifold_app;
