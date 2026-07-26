-- Bounded storage scheduler discovery and enqueue seams for Vercel Cron.
-- forward-fix: replace scheduler bodies/constraints in a successor migration; preserve queued work.
-- rollback: do not remove these live scheduler seams; forward-fix instead.
--
-- The scheduler intentionally enqueues one durable compaction trigger per cadence window.
-- A compactor always sweeps every closed, uncheckpointed window, so a missed Cron fire does
-- not create a correctness gap and does not require unbounded catch-up fan-out.
--
-- Forward-fix / rollback: additive only. Do not drop these functions on a live database;
-- a successor migration must replace their bodies or indexes while preserving queued work.

-- This migration has a nontransactional deployment step: CREATE INDEX CONCURRENTLY must run
-- outside a transaction (the migration runner already supports statement-level execution).
CREATE INDEX CONCURRENTLY "job_storage_compact_due_idx"
  ON "job_ledger" ("run_after", "workspace_id", "id")
  WHERE "kind" = 'storage.compact' AND "status" IN ('pending', 'claimed');--> statement-breakpoint

-- A near-term exhaustion forecast is operationally urgent even while current occupancy is below
-- warning. Reuse the bounded alert history with a distinct alert kind and explicit recovery.
ALTER TABLE "storage_pressure_alert" ADD CONSTRAINT "storage_pressure_alert_tier_chk_v2"
  CHECK ("tier" IN ('warning','high','critical','emergency','forecast_exhaustion_14d')) NOT VALID;--> statement-breakpoint
ALTER TABLE "storage_pressure_alert" VALIDATE CONSTRAINT "storage_pressure_alert_tier_chk_v2";--> statement-breakpoint
ALTER TABLE "storage_pressure_alert" DROP CONSTRAINT "storage_pressure_alert_tier_chk";--> statement-breakpoint
ALTER TABLE "storage_pressure_alert" RENAME CONSTRAINT "storage_pressure_alert_tier_chk_v2" TO "storage_pressure_alert_tier_chk";--> statement-breakpoint

-- ADR-0021 makes this a local deployment seam, not a directory-database scheduler. Every
-- storage Cron deployment is configured with one workspace database's pooled/direct URLs, so
-- attempting cross-workspace discovery here would be both misleading and unsafe. Fail closed if
-- the database cardinality ever ceases to be exactly one before we measure or enqueue work.
CREATE FUNCTION public.storage_scheduler_workspace_id()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_workspace_id text;
  v_count integer;
BEGIN
  SELECT count(*)::integer, min(w.id) INTO v_count, v_workspace_id FROM public.workspace w;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'database violates ADR-0021 one-workspace scheduler invariant';
  END IF;
  RETURN v_workspace_id;
END;
$function$;--> statement-breakpoint

-- The p_limit signature is retained for a uniform bounded Cron seam. The local topology always
-- yields exactly one row and rejects invalid limits rather than silently changing work scope.
CREATE FUNCTION public.storage_scheduler_due_workspaces(p_limit integer DEFAULT 25)
RETURNS TABLE (workspace_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'p_limit must be between 1 and 100'; END IF;
  RETURN QUERY SELECT public.storage_scheduler_workspace_id();
END;
$function$;--> statement-breakpoint

-- Durably enqueue one work item per cadence window.  The deterministic key makes overlapping
-- fires harmless; compaction's closed-window sweep supplies missed-window catch-up semantics.
CREATE FUNCTION public.enqueue_storage_compaction_schedule(p_cadence text, p_limit integer DEFAULT 25)
RETURNS TABLE (workspace_id text, job_id text, enqueued boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_window timestamptz;
  v_workspace_id text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100';
  END IF;
  IF p_cadence = 'hourly' THEN
    v_window := date_trunc('hour', now());
  ELSIF p_cadence = 'daily' THEN
    v_window := date_trunc('day', now());
  ELSIF p_cadence = 'monthly' THEN
    v_window := date_trunc('month', now());
  ELSE
    RAISE EXCEPTION 'unsupported storage compaction cadence';
  END IF;
  v_workspace_id := public.storage_scheduler_workspace_id();

  RETURN QUERY
  WITH attempted AS (
    INSERT INTO public.job_ledger (id, workspace_id, kind, payload, status, run_after, idempotency_key, created_at, updated_at)
    SELECT
      'job_storage_schedule_' || md5(v_workspace_id || ':' || p_cadence || ':' || v_window::text),
      v_workspace_id,
      'storage.compact',
      jsonb_build_object('scheduler', jsonb_build_object('cadence', p_cadence, 'windowStart', v_window)),
      'pending', now(),
      'storage-schedule:' || v_workspace_id || ':' || p_cadence || ':' || v_window::text,
      now(), now()
    ON CONFLICT (kind, idempotency_key) DO NOTHING
    RETURNING job_ledger.workspace_id AS inserted_workspace_id, job_ledger.id AS inserted_job_id
  )
  SELECT v_workspace_id, attempted.inserted_job_id, attempted.inserted_job_id IS NOT NULL
  FROM attempted
  UNION ALL
  SELECT v_workspace_id, NULL::text, false
  WHERE NOT EXISTS (SELECT 1 FROM attempted);
END;
$function$;--> statement-breakpoint

-- Claim discovery is bounded and exposes only the exact durable identity that the direct
-- compactor re-validates as (job_id, workspace_id, kind) before doing any work.
CREATE FUNCTION public.storage_compaction_due_jobs(p_limit integer DEFAULT 20)
RETURNS TABLE (job_id text, workspace_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT j.id, j.workspace_id
  FROM public.job_ledger j
  WHERE j.kind = 'storage.compact'
    AND j.workspace_id = public.storage_scheduler_workspace_id()
    AND ((j.status = 'pending' AND j.run_after <= now())
      OR (j.status = 'claimed' AND j.claimed_at <= now() - interval '2 minutes'))
  ORDER BY j.run_after, j.id
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$function$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.storage_scheduler_due_workspaces(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enqueue_storage_compaction_schedule(text, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.storage_compaction_due_jobs(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.storage_scheduler_workspace_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.storage_scheduler_due_workspaces(integer) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enqueue_storage_compaction_schedule(text, integer) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.storage_compaction_due_jobs(integer) TO manifold_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.storage_scheduler_workspace_id() TO manifold_app;
