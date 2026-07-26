-- Durable, append-only target-health facts and their mutable current projection.
--
-- A gateway provider attempt is first recorded as an immutable observation here.
-- The control plane owns reduction into gateway_target_health and later publishes
-- that projection in a new immutable configuration revision.  gateway_target
-- itself deliberately remains immutable.
-- forward-fix: retain observations and correct only the derived projection in a successor migration.
CREATE TABLE "gateway_target_health_observation" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "installation_id" text NOT NULL REFERENCES "gateway_installation"("id"),
  "target_id" text NOT NULL REFERENCES "gateway_target"("id"),
  "route_revision_id" text NOT NULL REFERENCES "gateway_route_revision"("id"),
  "snapshot_revision_id" text NOT NULL REFERENCES "gateway_config_revision"("id"),
  "source_event_id" text NOT NULL,
  "outcome" text NOT NULL,
  "http_status" integer,
  "reason_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "gateway_target_health_observation_outcome_chk"
    CHECK ("outcome" IN ('success','transient_failure','permanent_failure')),
  CONSTRAINT "gateway_target_health_observation_http_status_chk"
    CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599)
);--> statement-breakpoint

-- A source event is accepted at most once in a workspace, even if the ingest
-- job is retried with a fresh health-observation id.
CREATE UNIQUE INDEX "gateway_target_health_observation_source_event_uq"
  ON "gateway_target_health_observation" ("workspace_id", "source_event_id");--> statement-breakpoint
CREATE INDEX "gateway_target_health_observation_target_window_idx"
  ON "gateway_target_health_observation" ("workspace_id", "target_id", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "gateway_target_health_observation_installation_snapshot_idx"
  ON "gateway_target_health_observation" ("workspace_id", "installation_id", "snapshot_revision_id", "occurred_at" DESC);--> statement-breakpoint

CREATE TABLE "gateway_target_health" (
  "target_id" text PRIMARY KEY NOT NULL REFERENCES "gateway_target"("id"),
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "installation_id" text NOT NULL REFERENCES "gateway_installation"("id"),
  "route_revision_id" text NOT NULL REFERENCES "gateway_route_revision"("id"),
  "snapshot_revision_id" text NOT NULL REFERENCES "gateway_config_revision"("id"),
  "state" text NOT NULL DEFAULT 'unknown',
  "published_state" text NOT NULL DEFAULT 'unknown',
  "window_started_at" timestamp with time zone,
  "window_ended_at" timestamp with time zone,
  "sample_count" integer NOT NULL DEFAULT 0,
  "success_count" integer NOT NULL DEFAULT 0,
  "transient_failure_count" integer NOT NULL DEFAULT 0,
  "permanent_failure_count" integer NOT NULL DEFAULT 0,
  "consecutive_successes" integer NOT NULL DEFAULT 0,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_outcome" text,
  "last_observed_at" timestamp with time zone,
  "state_changed_at" timestamp with time zone,
  "last_rolled_up_at" timestamp with time zone,
  "next_expiry_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "gateway_target_health_state_chk"
    CHECK ("state" IN ('unknown','healthy','degraded','unhealthy')),
  CONSTRAINT "gateway_target_health_published_state_chk"
    CHECK ("published_state" IN ('unknown','healthy','degraded','unhealthy')),
  CONSTRAINT "gateway_target_health_last_outcome_chk"
    CHECK ("last_outcome" IS NULL OR "last_outcome" IN ('success','transient_failure','permanent_failure')),
  CONSTRAINT "gateway_target_health_counts_nonneg_chk"
    CHECK (
      "sample_count" >= 0
      AND "success_count" >= 0
      AND "transient_failure_count" >= 0
      AND "permanent_failure_count" >= 0
      AND "consecutive_successes" >= 0
      AND "consecutive_failures" >= 0
    ),
  CONSTRAINT "gateway_target_health_counts_sum_chk"
    CHECK ("sample_count" = "success_count" + "transient_failure_count" + "permanent_failure_count"),
  CONSTRAINT "gateway_target_health_window_order_chk"
    CHECK ("window_started_at" IS NULL OR "window_ended_at" IS NULL OR "window_started_at" <= "window_ended_at")
);--> statement-breakpoint

CREATE INDEX "gateway_target_health_expiry_idx"
  ON "gateway_target_health" ("next_expiry_at")
  WHERE "next_expiry_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "gateway_target_health_installation_state_idx"
  ON "gateway_target_health" ("workspace_id", "installation_id", "state");--> statement-breakpoint

ALTER TABLE "config_operation"
  DROP CONSTRAINT "config_operation_kind_chk";--> statement-breakpoint
ALTER TABLE "config_operation"
  ADD CONSTRAINT "config_operation_kind_chk"
  CHECK ("operation_kind" IN ('apply','rollback','key_publish','health_publish'));--> statement-breakpoint

-- Cron cannot enumerate tenant workspaces through RLS. This deliberately narrow
-- definer seam returns only bounded workspace IDs; all claim/reduction/publish
-- work still executes later inside the caller's workspace-scoped transaction.
CREATE OR REPLACE FUNCTION "target_health_due_workspaces"(p_limit integer DEFAULT 25)
RETURNS TABLE (workspace_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT due.workspace_id
  FROM (
    SELECT j.workspace_id, min(j.run_after) AS due_at
    FROM job_ledger j
    WHERE j.workspace_id IS NOT NULL
      AND j.kind IN ('target_health_rollup', 'target_health_publish')
      AND (
        (j.status = 'pending' AND j.run_after <= now())
        OR (
          j.status = 'claimed'
          AND j.claimed_at <= now() - interval '60 seconds'
        )
      )
    GROUP BY j.workspace_id
    UNION ALL
    SELECT h.workspace_id, min(h.next_expiry_at) AS due_at
    FROM gateway_target_health h
    WHERE h.next_expiry_at <= now()
    GROUP BY h.workspace_id
  ) due
  GROUP BY due.workspace_id
  ORDER BY min(due.due_at), due.workspace_id
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "target_health_due_workspaces"(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "target_health_due_workspaces"(integer) TO manifold_app;--> statement-breakpoint

-- Health facts are an immutable, append-only audit source.  The projection is
-- intentionally mutable only through the control-plane reducer.
CREATE TRIGGER "gateway_target_health_observation_immutable"
  BEFORE UPDATE OR DELETE ON "gateway_target_health_observation"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

ALTER TABLE "gateway_target_health_observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gateway_target_health_observation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "gateway_target_health_observation_rls" ON "gateway_target_health_observation"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
ALTER TABLE "gateway_target_health" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gateway_target_health" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "gateway_target_health_rls" ON "gateway_target_health"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint

GRANT SELECT, INSERT ON "gateway_target_health_observation" TO manifold_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gateway_target_health" TO manifold_app;
