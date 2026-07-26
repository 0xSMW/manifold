-- forward-fix: preserve pending recovery work and replace claim functions through a later migration.
CREATE OR REPLACE FUNCTION public.claim_config_publication_recovery(p_limit integer DEFAULT 20)
RETURNS TABLE(workspace_id text, operation_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH superseded_operations AS (
    -- Retire old operations before applying the batch limit.  An old operation can never make
    -- progress once its revision is no longer active, and leaving it retryable lets a backlog of
    -- stale rows starve the current configuration indefinitely.
    UPDATE public.config_operation o
    SET accelerator_status = 'superseded',
        error = jsonb_build_object('reason', 'superseded'),
        completed_at = COALESCE(o.completed_at, now()),
        last_reconcile_at = now()
    WHERE o.accelerator_status IN ('pending', 'reconciliation_required')
      AND o.revision_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.gateway_config_revision r
        WHERE r.id = o.revision_id AND r.status = 'active'
      )
    RETURNING o.workspace_id, o.id
  ), superseded_jobs AS (
    UPDATE public.job_ledger j
    SET status = 'superseded', claimed_at = NULL, claimed_by = NULL,
        last_error = jsonb_build_object('reason', 'superseded'), updated_at = now()
    FROM superseded_operations o
    WHERE j.workspace_id = o.workspace_id
      AND j.kind = 'config_publish_reconcile'
      AND j.idempotency_key = 'config_publish:' || o.id
      AND j.status IN ('pending', 'claimed')
  ), latest_active_operation AS (
    SELECT DISTINCT ON (o.installation_id) o.workspace_id, o.id, o.created_at
    FROM public.config_operation o
    JOIN public.gateway_config_revision r ON r.id = o.revision_id AND r.status = 'active'
    WHERE o.accelerator_status IN ('pending', 'reconciliation_required')
    ORDER BY o.installation_id, o.created_at DESC, o.id DESC
  )
  SELECT o.workspace_id, o.id
  FROM latest_active_operation o
  ORDER BY o.created_at, o.id
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;
REVOKE ALL ON FUNCTION public.claim_config_publication_recovery(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_config_publication_recovery(integer) TO manifold_app;
--> statement-breakpoint
ALTER TABLE public.config_operation
  ADD CONSTRAINT config_operation_accelerator_status_chk_v2
  CHECK (accelerator_status IN ('not_configured','pending','published','reconciliation_required','superseded')) NOT VALID;
ALTER TABLE public.config_operation VALIDATE CONSTRAINT config_operation_accelerator_status_chk_v2;
ALTER TABLE public.config_operation DROP CONSTRAINT config_operation_accelerator_status_chk;
ALTER TABLE public.config_operation RENAME CONSTRAINT config_operation_accelerator_status_chk_v2
  TO config_operation_accelerator_status_chk;
--> statement-breakpoint
ALTER TABLE public.job_ledger
  ADD CONSTRAINT job_ledger_status_chk_v2
  CHECK (status IN ('pending','claimed','done','failed','dead','superseded')) NOT VALID;
ALTER TABLE public.job_ledger VALIDATE CONSTRAINT job_ledger_status_chk_v2;
ALTER TABLE public.job_ledger DROP CONSTRAINT job_ledger_status_chk;
ALTER TABLE public.job_ledger RENAME CONSTRAINT job_ledger_status_chk_v2 TO job_ledger_status_chk;
--> statement-breakpoint
-- Key mutations coalesce in job_ledger rather than config_operation. Include pending work and
-- reclaimable leases so a failed worker cannot strand a key change indefinitely.
CREATE OR REPLACE FUNCTION public.claim_config_key_publication_recovery(p_limit integer DEFAULT 20)
RETURNS TABLE(workspace_id text, installation_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT j.workspace_id, j.payload->>'installationId'
  FROM public.job_ledger j
  WHERE j.kind = 'config_key_publish'
    AND j.workspace_id IS NOT NULL
    AND j.payload->>'installationId' IS NOT NULL
    AND (j.status = 'pending' OR (j.status = 'claimed' AND j.claimed_at <= now() - interval '60 seconds'))
  ORDER BY j.updated_at
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;
REVOKE ALL ON FUNCTION public.claim_config_key_publication_recovery(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_config_key_publication_recovery(integer) TO manifold_app;
