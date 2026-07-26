-- Durable config publication state and persisted, single-use destructive approvals.
-- forward-fix: preserve existing operation history and correct publication state with a later migration.
ALTER TABLE "config_operation"
  ADD COLUMN "operation_kind" text NOT NULL DEFAULT 'apply',
  ADD COLUMN "revision_id" text REFERENCES "gateway_config_revision"("id"),
  ADD COLUMN "serving_mode" text NOT NULL DEFAULT 'boot_fallback',
  ADD COLUMN "accelerator_status" text NOT NULL DEFAULT 'not_configured',
  ADD COLUMN "reconciliation_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "last_reconcile_at" timestamp with time zone,
  ADD COLUMN "completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "config_operation"
  ADD CONSTRAINT "config_operation_installation_fk"
  FOREIGN KEY ("installation_id") REFERENCES "gateway_installation"("id");
CREATE INDEX "config_operation_reconcile_idx"
  ON "config_operation" ("workspace_id","accelerator_status","created_at")
  WHERE "accelerator_status" IN ('pending','reconciliation_required');
--> statement-breakpoint
ALTER TABLE "config_operation"
  ADD CONSTRAINT "config_operation_kind_chk"
    CHECK ("operation_kind" IN ('apply','rollback','key_publish')),
  ADD CONSTRAINT "config_operation_serving_mode_chk"
    CHECK ("serving_mode" IN ('boot_fallback','edge_config')),
  ADD CONSTRAINT "config_operation_accelerator_status_chk"
    CHECK ("accelerator_status" IN ('not_configured','pending','published','reconciliation_required'));
--> statement-breakpoint
CREATE TABLE "config_tripwire_approval" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "installation_id" text NOT NULL REFERENCES "gateway_installation"("id"),
  "plan_hash" text NOT NULL,
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "approved_by" text NOT NULL REFERENCES "member"("id"),
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "used_by_operation_id" text REFERENCES "config_operation"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "config_tripwire_approval_kind_chk"
    CHECK ("kind" IN ('route_delete','entitlement_removal','budget_enforcement_relaxed')),
  CONSTRAINT "config_tripwire_approval_expiry_chk" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "config_tripwire_approval_usage_chk"
    CHECK (("used_at" IS NULL) = ("used_by_operation_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "config_tripwire_approval_identity_idx"
  ON "config_tripwire_approval"
  ("workspace_id","installation_id","plan_hash","kind","ref");
--> statement-breakpoint
CREATE INDEX "config_tripwire_approval_lookup_idx"
  ON "config_tripwire_approval" ("workspace_id","installation_id","plan_hash");
--> statement-breakpoint
ALTER TABLE "config_tripwire_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "config_tripwire_approval" FORCE ROW LEVEL SECURITY;
CREATE POLICY "config_tripwire_approval_rls" ON "config_tripwire_approval"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "config_tripwire_approval" TO manifold_app;
GRANT SELECT, INSERT, UPDATE ON "config_operation" TO manifold_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION config_tripwire_approval_guard_mutation() RETURNS trigger AS $$
DECLARE
  n config_tripwire_approval := NEW;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_ROW: DELETE on config_tripwire_approval';
  END IF;
  IF OLD.used_at IS NOT NULL
     OR NEW.used_at IS NULL
     OR NEW.used_by_operation_id IS NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_ROW: illegal config approval mutation';
  END IF;
  n.used_at := OLD.used_at;
  n.used_by_operation_id := OLD.used_by_operation_id;
  IF ROW(n.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'IMMUTABLE_ROW: forbidden column change on config_tripwire_approval';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER config_tripwire_approval_immutable
  BEFORE UPDATE OR DELETE ON "config_tripwire_approval"
  FOR EACH ROW EXECUTE FUNCTION config_tripwire_approval_guard_mutation();
--> statement-breakpoint
-- Rollback re-publishes an existing immutable revision. Only its lifecycle status changes.
-- Allow the selected historical row to become active again after the current active row is
-- first marked rolled_back. Snapshot bytes and every identity column remain frozen.
CREATE OR REPLACE FUNCTION config_revision_guard_mutation() RETURNS trigger AS $$
DECLARE
  n gateway_config_revision := NEW;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_ROW: DELETE on gateway_config_revision';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('superseded','rolled_back'))
       OR (OLD.status IN ('superseded','rolled_back') AND NEW.status = 'active')
     ) THEN
    RAISE EXCEPTION 'IMMUTABLE_ROW: illegal status transition on gateway_config_revision';
  END IF;
  n.status := OLD.status;
  IF ROW(n.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'IMMUTABLE_ROW: forbidden column change on gateway_config_revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
