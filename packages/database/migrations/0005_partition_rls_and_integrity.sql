-- ===========================================================================
-- 0005_partition_rls_and_integrity.sql — close the partition-RLS leak and add
--   money-truth integrity constraints (SPEC §6.13/§6.15/§6.16, §16.3).
--
-- Postgres does NOT inherit ENABLE/FORCE ROW LEVEL SECURITY or CREATE POLICY from a
-- partitioned PARENT to its partition CHILDREN. RLS is applied by the relation NAMED in
-- the query: querying the parent applies the parent's policies (children scanned under
-- them), but querying a CHILD partition directly (e.g. `SELECT … FROM observation_202607`)
-- applies only the CHILD's own RLS — and the bootstrap children created in 0001 had none.
-- Because manifold_app holds DML on every partition (0002 ALTER DEFAULT PRIVILEGES), a
-- direct child query returned ALL tenants' rows: a full cross-tenant leak.
--
-- This migration:
--   1. Rewrites create_month_partition() so every FUTURE monthly partition is created with
--      ENABLE + FORCE RLS and the same workspace_id policy as its parent.
--   2. Adds a DEFAULT partition to each RANGE parent so an out-of-range created_at lands in
--      a catchable partition instead of erroring ingest (the app still validates/denies
--      out-of-range at the boundary — the default is a safety net, not a license).
--   3. Backfills ENABLE + FORCE RLS + policy onto EVERY existing partition child (the 0001
--      bootstrap monthly children, the usage_aggregate LIST children, and the new DEFAULT
--      children just created).
--   4. Adds idempotent-re-ingest UNIQUE indexes on the money-truth tables.
--   5. Adds a non-negativity CHECK to budget_window_state and (guarded) SET NOT NULL on
--      budget_reservation.window_start.
--   6. Adds the reservation-sweep partial index.
--
-- NOTE on who runs create_month_partition(): partition creation + the ALTER/CREATE POLICY it
-- now performs are DDL that requires table ownership, so the daily maintenance job must call
-- it as the migration owner / a privileged role (the same seam 0001 used), never as the
-- tenant-facing manifold_app role. The function is intentionally NOT SECURITY DEFINER, matching
-- 0001.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Rewrite create_month_partition(): new partitions are born with RLS + policy.
--    Idempotent: CREATE TABLE IF NOT EXISTS, ENABLE/FORCE are no-ops if already set, and the
--    policy is created only if absent, so re-running for an existing month is harmless.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_month_partition(p_parent text, p_month date)
RETURNS text AS $$
DECLARE
	v_start date := date_trunc('month', p_month)::date;
	v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
	v_name  text := format('%s_%s', p_parent, to_char(v_start, 'YYYYMM'));
BEGIN
	EXECUTE format(
		'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
		v_name, p_parent, v_start, v_end
	);
	-- RLS does NOT inherit from the parent; enable + force + policy on the child itself.
	EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_name);
	EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_name);
	IF NOT EXISTS (
		SELECT 1 FROM pg_policy WHERE polrelid = v_name::regclass AND polname = v_name || '_rls'
	) THEN
		EXECUTE format(
			'CREATE POLICY %I ON %I USING (workspace_id = current_setting(''manifold.workspace_id'', true))',
			v_name || '_rls', v_name
		);
	END IF;
	RETURN v_name;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. DEFAULT partitions for each RANGE parent (§6.13). An out-of-range created_at now lands
--    here instead of raising "no partition of relation …" and failing ingest. usage_aggregate
--    is LIST-partitioned with a CHECK that already restricts grain to the three values that all
--    have explicit partitions, so it needs no default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "observation_event_default"  PARTITION OF "observation_event"  DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "observation_default"        PARTITION OF "observation"        DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trace_summary_default"      PARTITION OF "trace_summary"      DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_decision_default"    PARTITION OF "policy_decision"    DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_record_default"       PARTITION OF "usage_record"       DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_ledger_default"        PARTITION OF "cost_ledger"        DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_event_default"        PARTITION OF "audit_event"        DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_reservation_default" PARTITION OF "budget_reservation" DEFAULT;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Backfill RLS onto EVERY existing partition child of every partitioned parent (bootstrap
--    monthly children from 0001, the LIST children, and the DEFAULT children just created).
--    Loops pg_inherits so it self-adjusts to whatever children exist. ENABLE/FORCE are
--    idempotent; the policy is created only if absent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
	r record;
	parents text[] := ARRAY[
		'budget_reservation','observation_event','observation','trace_summary',
		'policy_decision','usage_record','cost_ledger','audit_event','usage_aggregate'
	];
	p text;
BEGIN
	FOREACH p IN ARRAY parents LOOP
		FOR r IN
			SELECT inhrelid::regclass AS child, c.relname AS relname
			FROM pg_inherits
			JOIN pg_class c ON c.oid = pg_inherits.inhrelid
			WHERE inhparent = p::regclass
		LOOP
			EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.child);
			EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.child);
			IF NOT EXISTS (
				SELECT 1 FROM pg_policy WHERE polrelid = r.child AND polname = r.relname || '_rls'
			) THEN
				EXECUTE format(
					'CREATE POLICY %I ON %s USING (workspace_id = current_setting(''manifold.workspace_id'', true))',
					r.relname || '_rls', r.child
				);
			END IF;
		END LOOP;
	END LOOP;
END$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Idempotent-re-ingest UNIQUE indexes on the money-truth tables (§6.9/§6.10). Together
--    with ON CONFLICT DO NOTHING and a DETERMINISTIC created_at in the writer (observe.ts),
--    a replayed observation cannot double-insert cost/usage. created_at is REQUIRED in the key
--    because these tables are partitioned by it (a unique index on a partitioned table must
--    include every partition-key column). This dedups ONLY if the writer derives created_at
--    deterministically from the trace/observation ULID rather than now() — that writer change
--    is owned elsewhere; the index is the enabling groundwork.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "cost_ledger_ingest_uq"  ON "cost_ledger"  USING btree ("workspace_id","observation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_record_ingest_uq" ON "usage_record" USING btree ("workspace_id","observation_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. budget_window_state non-negativity (§16.3): committed/reserved counters can never go
--    below zero. And SET NOT NULL on budget_reservation.window_start — added nullable by 0003
--    only because it was bolted onto an existing partitioned table; reserve() always writes it.
--    Guarded so it applies cleanly whether or not legacy NULL rows exist (on a fresh DB there
--    are none, so it always tightens). The app must never write NULL going forward.
-- ---------------------------------------------------------------------------
ALTER TABLE "budget_window_state"
	ADD CONSTRAINT "budget_window_state_nonneg_chk"
	CHECK ("committed_microusd" >= 0 AND "reserved_microusd" >= 0
	   AND "committed_tokens" >= 0 AND "reserved_tokens" >= 0);--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM budget_reservation WHERE window_start IS NULL) THEN
		ALTER TABLE budget_reservation ALTER COLUMN window_start SET NOT NULL;
	END IF;
END$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Reservation-sweep partial index (§16.3): sweepExpired() scans for reserved rows past
--    expiry. Without this it seq-scans every partition. Partial on status='reserved' keeps the
--    index tiny (committed/rolled_back/expired rows are excluded). Propagated to every partition.
-- ---------------------------------------------------------------------------
CREATE INDEX "reservation_sweep_idx" ON "budget_reservation" USING btree ("expires_at") WHERE status = 'reserved';
