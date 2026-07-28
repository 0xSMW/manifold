-- Usage projections are append-only evidence. Corrections are projected as new rows and retention
-- removes only whole partitions, never individual usage records.
-- forward-fix: retain immutable usage rows and add a corrective successor migration; do not restore
-- row-level UPDATE/DELETE authority or rewrite recorded usage.
-- rollback: stop writers that require a later schema revision and forward-fix; this migration is
-- intentionally non-destructive, so already-recorded usage remains protected.

-- Bring usage_record in line with the other immutable projection tables. The parent trigger is
-- cloned onto partitions by Postgres, including partitions made after this migration.
CREATE TRIGGER "usage_record_immutable"
  BEFORE UPDATE OR DELETE ON "usage_record"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

-- 0002 granted broad DML to the runtime role. Revoke mutation authority from the partitioned
-- parent AND every existing child so queries addressed directly to a child cannot bypass the
-- intended append-only interface. Explicitly retain the ingestion/read capability; RLS still
-- requires the request transaction to set manifold.workspace_id.
DO $$
DECLARE
  relation_name regclass;
BEGIN
  FOR relation_name IN
    SELECT 'usage_record'::regclass
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent = 'usage_record'::regclass
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE %s FROM manifold_app', relation_name);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %s TO manifold_app', relation_name);
  END LOOP;
END;
$$;--> statement-breakpoint

-- The role's broad default privileges remain necessary for other runtime tables. Rewrite the
-- partition helper so each future usage_record partition immediately loses UPDATE/DELETE while
-- retaining SELECT/INSERT. Other partition parents keep their existing grants unchanged.
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
  IF p_parent = 'usage_record' THEN
    EXECUTE format('REVOKE UPDATE, DELETE ON TABLE %I FROM manifold_app', v_name);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO manifold_app', v_name);
  END IF;
  RETURN v_name;
END;
$$ LANGUAGE plpgsql;
