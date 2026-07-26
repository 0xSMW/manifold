-- Scheduled, bounded retention for mutation replay journals and rate-limit buckets.
-- forward-fix: replace the cleanup function or indexes in a successor migration while preserving expired-row cleanup.
-- NONTRANSACTIONAL MIGRATION: production applies each numbered SQL file directly with psql (see
-- Docs/DEPLOY.md). CREATE INDEX CONCURRENTLY refuses a transaction block, which is the required
-- guard against accidentally running this file through a transaction-wrapping migration runner.
--
-- Forward-fix note: this migration is intentionally additive and must not be rolled back on a
-- live database.  If its cleanup policy needs changing, ship a later forward migration that
-- replaces this function; dropping it can strand expired sensitive replay ciphertext indefinitely.

-- The existing tenant-leading indexes serve request-path deletes.  The worker intentionally scans
-- expiration across tenants, so it needs an expiration-leading index to stay bounded after a quiet
-- tenant (or the whole service) becomes inactive.
CREATE INDEX CONCURRENTLY "mutation_idempotency_cleanup_expiry_idx"
  ON "mutation_idempotency" ("expires_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "mutation_rate_limit_bucket_cleanup_expiry_idx"
  ON "mutation_rate_limit_bucket" ("expires_at");--> statement-breakpoint

-- This is the sole cross-tenant mutation seam for scheduled retention.  It does not accept a
-- workspace ID or arbitrary SQL predicate; each invocation deletes only expired rows, with an
-- independent bounded batch for each table. SKIP LOCKED makes overlapping cron retries safe.
CREATE FUNCTION public.cleanup_expired_mutation_guards(batch_limit integer DEFAULT 200)
RETURNS TABLE(replay_rows_deleted integer, rate_buckets_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'batch_limit must be between 1 and 1000';
  END IF;

  WITH due AS (
    SELECT ctid
    FROM public.mutation_idempotency
    WHERE expires_at <= now()
    ORDER BY expires_at
    FOR UPDATE SKIP LOCKED
    LIMIT batch_limit
  )
  DELETE FROM public.mutation_idempotency journal
  USING due
  WHERE journal.ctid = due.ctid;
  GET DIAGNOSTICS replay_rows_deleted = ROW_COUNT;

  WITH due AS (
    SELECT ctid
    FROM public.mutation_rate_limit_bucket
    WHERE expires_at <= now()
    ORDER BY expires_at
    FOR UPDATE SKIP LOCKED
    LIMIT batch_limit
  )
  DELETE FROM public.mutation_rate_limit_bucket bucket
  USING due
  WHERE bucket.ctid = due.ctid;
  GET DIAGNOSTICS rate_buckets_deleted = ROW_COUNT;

  RETURN NEXT;
END;
$function$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.cleanup_expired_mutation_guards(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cleanup_expired_mutation_guards(integer) TO manifold_app;
