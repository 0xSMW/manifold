// Adversarial tenant-isolation + schema-invariant tests for @manifold/database.
//
// These are COMMITTED, re-runnable integration tests. Each run spins up its OWN
// throwaway Postgres 16 container (unique name + published loopback port), applies
// BOTH migrations, ATTACKS the isolation / immutability / partition invariants, then
// tears the container down in an `after` hook even on failure.
//
// Coverage (SPEC references):
//   * §6.16 / §15.2  — Row-level security fail-closed isolation (the attack runs as a
//                      non-superuser app role, exactly what a compromised gateway request
//                      would use; seeding uses the owner/superuser path that legitimately
//                      bypasses RLS, modelling migrations / the control plane).
//   * §6.7 (B1)      — reservation_request_uq idempotency + partition routing + the
//                      pg_partitioned_table shape (8 RANGE + 1 LIST).
//   * §6.15          — immutability triggers (IMMUTABLE_ROW) and the two whitelisted deltas.
//
// Container/migration lifecycle is the shared `startPg` harness (test/pg-harness.ts); this
// suite adds only its own two-workspace seed and the non-superuser `app_role` the ATTACKs
// run as. See the harness for the loopback-port / `docker exec … psql` rationale.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { startPg, type PgHarness } from "./pg-harness.ts";

type Sql = ReturnType<typeof postgres>;

let pg: PgHarness;
let sql: Sql;

before(async () => {
  pg = await startPg({ namePrefix: "mf-db-test" });
  sql = pg.sql;

  // Seed reference/tenant rows for TWO workspaces (superuser => RLS-exempt, the migration
  // / control-plane path), and create the non-superuser app role the attacks run as.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_a','ws-a','Workspace A','local'),
      ('ws_b','ws-b','Workspace B','local');

    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_a','ws_a','inst-a','{"kind":"test"}'),
      ('inst_b','ws_b','inst-b','{"kind":"test"}');

    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_a','ws_a','inst_a','a.local','public_app','{}'),
      ('prof_b','ws_b','inst_b','b.local','public_app','{}');

    INSERT INTO member (id, workspace_id, email, name, role) VALUES
      ('mbr_a','ws_a','a@example.com','Member A','owner'),
      ('mbr_b','ws_b','b@example.com','Member B','owner');

    INSERT INTO console_session
      (id, workspace_id, member_id, keyed_hash, scopes, expires_at) VALUES
      ('ses_a','ws_a','mbr_a','\\xaa','["routes:read"]',now() + interval '1 hour'),
      ('ses_b','ws_b','mbr_b','\\xbb','["routes:read"]',now() + interval '1 hour');

    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes) VALUES
      ('vk_a','ws_a','prof_a','mfa','\\x01','[]'),
      ('vk_b','ws_b','prof_b','mfb','\\x02','[]');

    INSERT INTO budget_account
      (id, workspace_id, scope_type, unit, "window", limit_amount, enforcement) VALUES
      ('ba_a','ws_a','workspace','cost_microusd','monthly',1000000,'advisory');

    INSERT INTO cost_ledger (id, workspace_id, amount_microusd, fidelity, occurred_at) VALUES
      ('cl-1','ws_a',500,'exact', now());

    INSERT INTO observation
      (id, workspace_id, trace_id, installation_id, profile_mode, status, occurred_at) VALUES
      ('obs-del','ws_a','tr-1','inst_a','public_app','ok', now()),
      ('obs-comp','ws_a','tr-2','inst_a','public_app','ok', now());

    INSERT INTO gateway_config_revision
      (id, workspace_id, installation_id, content_hash, snapshot, status) VALUES
      ('cfg-1','ws_a','inst_a','sha256:abc','{}','active');

    CREATE ROLE app_role NOLOGIN;
    GRANT USAGE ON SCHEMA public TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role;
  `);
}, { timeout: 180_000 });

after(async () => {
  if (pg) await pg.stop();
});

// ---------------------------------------------------------------------------
// 2. ATTACK tenant isolation as the non-superuser app role (§6.16 / §15.2).
// ---------------------------------------------------------------------------

test("RLS: SELECT with no WHERE returns ONLY the current tenant's rows", async () => {
  const rows = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE app_role");
    await tx.unsafe("SELECT set_config('manifold.workspace_id','ws_a', true)");
    // Deliberately NO where-clause: RLS must scope this to ws_a.
    return tx.unsafe("SELECT id, workspace_id FROM virtual_key");
  });
  assert.equal(rows.length, 1, "should see exactly one (ws_a) virtual_key");
  assert.equal(rows[0].id, "vk_a");
  assert.equal(rows[0].workspace_id, "ws_a");
  for (const r of rows) assert.equal(r.workspace_id, "ws_a");
});

test("RLS: cross-tenant UPDATE of ws_b rows affects 0 rows", async () => {
  const res = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE app_role");
    await tx.unsafe("SELECT set_config('manifold.workspace_id','ws_a', true)");
    return tx.unsafe("UPDATE virtual_key SET display_prefix='hacked' WHERE id='vk_b'");
  });
  assert.equal(res.count, 0, "ws_b row is invisible to ws_a -> 0 rows updated");

  // Prove the ws_b row is genuinely untouched (checked as superuser, RLS-exempt).
  const [vkb] = await sql`SELECT display_prefix FROM virtual_key WHERE id='vk_b'`;
  assert.equal(vkb.display_prefix, "mfb");
});

test("RLS: cross-tenant DELETE of ws_b rows affects 0 rows", async () => {
  const res = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE app_role");
    await tx.unsafe("SELECT set_config('manifold.workspace_id','ws_a', true)");
    return tx.unsafe("DELETE FROM virtual_key WHERE id='vk_b'");
  });
  assert.equal(res.count, 0, "ws_b row is invisible to ws_a -> 0 rows deleted");

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM virtual_key WHERE id='vk_b'`;
  assert.equal(n, 1, "ws_b row still present");
});

test("RLS: with the GUC UNSET the select returns 0 rows (fail-closed, not an error)", async () => {
  let threw = false;
  let rows: Awaited<ReturnType<Sql["unsafe"]>> | undefined;
  try {
    rows = await sql.begin(async (tx: Sql) => {
      await tx.unsafe("SET LOCAL ROLE app_role");
      // Intentionally do NOT set manifold.workspace_id: current_setting(...,true) -> NULL.
      return tx.unsafe("SELECT id FROM virtual_key");
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "must fail CLOSED (empty result), not leak an error");
  assert.equal(rows!.length, 0, "unset GUC => NULL => no rows match => 0 rows");
});

test("RLS: WITH CHECK blocks writing a foreign-tenant row (fail-closed on write)", async () => {
  let err: { code?: string; message?: string } | undefined;
  try {
    await sql.begin(async (tx: Sql) => {
      await tx.unsafe("SET LOCAL ROLE app_role");
      await tx.unsafe("SELECT set_config('manifold.workspace_id','ws_a', true)");
      // ws_a is the active tenant; inserting a ws_b row must be rejected by RLS.
      return tx.unsafe(
        "INSERT INTO virtual_key (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes)" +
        " VALUES ('vk_evil','ws_b','prof_b','evil','\\x03','[]')",
      );
    });
  } catch (e) {
    err = e as { code?: string; message?: string };
  }
  assert.ok(err, "insert of a foreign-tenant row must be rejected");
  assert.match(err!.message ?? "", /row-level security/i);
  assert.equal(err!.code, "42501");
});

test("RLS: querying a partition CHILD directly is workspace-scoped (finding 1, the leak)", async () => {
  // Postgres does NOT inherit RLS from a partitioned parent to its children. Before 0005 the
  // bootstrap children had no RLS, so `SELECT … FROM cost_ledger_YYYYMM` (naming the child)
  // returned EVERY tenant's rows. Seed a second-tenant (ws_b) row co-located in the SAME child
  // as the ws_a seed row, then read the child DIRECTLY as the app role under ws_a's GUC.
  await sql`INSERT INTO cost_ledger ${sql({
    id: "cl-b", workspace_id: "ws_b", amount_microusd: 700, fidelity: "exact",
    occurred_at: new Date(),
  })}`;

  // Resolve the concrete monthly child partition that holds cost_ledger rows (created for
  // CURRENT_DATE by 0001; both cl-1 and cl-b default created_at=now() land in it).
  const [{ child }] = await sql`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'cost_ledger'::regclass
      AND c.relname <> 'cost_ledger_default'
  `;
  assert.ok(child, "a monthly cost_ledger child partition must exist");

  // As superuser (RLS-exempt) both tenants' rows are physically in that child.
  const allRows = await sql.unsafe(
    `SELECT id, workspace_id FROM "${child}" ORDER BY id`,
  );
  assert.equal(allRows.length, 2, "both ws_a and ws_b rows are co-located in the child");

  // As the non-superuser app role under ws_a's GUC, a DIRECT child query must show ONLY ws_a.
  const scoped = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE app_role");
    await tx.unsafe("SELECT set_config('manifold.workspace_id','ws_a', true)");
    return tx.unsafe(`SELECT id, workspace_id FROM "${child}"`);
  });
  assert.equal(scoped.length, 1, "child partition RLS must scope a direct child query to ws_a");
  assert.equal(scoped[0].workspace_id, "ws_a");
  assert.equal(scoped[0].id, "cl-1");
  for (const r of scoped) assert.equal(r.workspace_id, "ws_a", "no ws_b row may leak via the child");
});

test("console session RLS exposes only the current workspace", async () => {
  const rows = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE app_role");
    await tx.unsafe("SELECT set_config('manifold.workspace_id','ws_a', true)");
    return tx.unsafe("SELECT id, workspace_id FROM console_session");
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "ses_a");
  assert.equal(rows[0].workspace_id, "ws_a");
});

test("console session auth lookup is exact-hash-only before tenant resolution", async () => {
  const found = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    return tx.unsafe("SELECT id, workspace_id, member_id FROM auth_lookup_console_session('\\xaa')");
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ses_a");
  assert.equal(found[0].workspace_id, "ws_a");
  assert.equal(found[0].member_id, "mbr_a");

  const missing = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    return tx.unsafe("SELECT id FROM auth_lookup_console_session('\\xcc')");
  });
  assert.equal(missing.length, 0);
});

test("CLI device lookup is exact-hash-only before tenant resolution", async () => {
  await sql.unsafe(
    "INSERT INTO cli_authorization (id, workspace_id, device_code_hash, user_code, status, scopes, client_id, client_name, verification_origin, interval_seconds, poll_not_before, expires_at) " +
    "VALUES ('clia_a','ws_a','\\xcc','AAAAA-BBBBB','pending','[\"routes:read\"]','manifold-cli','Manifold CLI','https://console.example',5,now(),now() + interval '10 minutes')",
  );
  const rows = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    return tx.unsafe("SELECT id, workspace_id FROM auth_lookup_cli_authorization('\\xcc'::bytea)");
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "clia_a");
  assert.equal(rows[0].workspace_id, "ws_a");
  const missing = await sql.begin(async (tx: Sql) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    return tx.unsafe("SELECT id FROM auth_lookup_cli_authorization('\\xcd'::bytea)");
  });
  assert.equal(missing.length, 0, "a non-matching device-code hash cannot enumerate grants");
});

// ---------------------------------------------------------------------------
// 3. ATTACK B1: reservation idempotency + partition routing + partition shape (§6.7).
// ---------------------------------------------------------------------------

// A fixed instant inside the CURRENT month, so it lands in the initial partition that
// migration 0001 creates for CURRENT_DATE regardless of which month the suite runs in.
function currentMonthInstant(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0));
}

test("B1: duplicate reservation (same account+request+created_at) is rejected by reservation_request_uq", async () => {
  const ts = currentMonthInstant();
  const exp = new Date(ts.getTime() + 3_600_000);

  // First reservation succeeds. window_start is NOT NULL as of 0005; reserve() always writes it.
  await sql`INSERT INTO budget_reservation ${sql({
    id: "res-1", workspace_id: "ws_a", budget_account_id: "ba_a", request_id: "req-1",
    estimated_input_tokens: 10, max_output_tokens: 10, reserved_microusd: 100,
    status: "reserved", expires_at: exp, created_at: ts, window_start: ts,
  })}`;

  // Duplicate on (budget_account_id, request_id, created_at) must be rejected.
  let err: { code?: string; message?: string; constraint_name?: string } | undefined;
  try {
    await sql`INSERT INTO budget_reservation ${sql({
      id: "res-2", workspace_id: "ws_a", budget_account_id: "ba_a", request_id: "req-1",
      estimated_input_tokens: 99, max_output_tokens: 99, reserved_microusd: 999,
      status: "reserved", expires_at: exp, created_at: ts, window_start: ts,
    })}`;
  } catch (e) {
    err = e as typeof err;
  }
  assert.ok(err, "duplicate reserve must be rejected (idempotent reserve, B1)");
  assert.equal(err!.code, "23505", "unique_violation");
  assert.match(
    `${err!.constraint_name ?? ""} ${err!.message ?? ""}`,
    /reservation_request_uq|duplicate key/i,
  );
});

test("finding-5: an out-of-range created_at lands in the DEFAULT partition (ingest doesn't error)", async () => {
  // Migration 0005 adds a DEFAULT partition to every RANGE parent so an out-of-month created_at
  // no longer raises "no partition of relation …" and hard-fails ingest. (The app still
  // validates/denies out-of-range at the boundary; the default is a safety net.)
  const outside = new Date(Date.UTC(2000, 0, 1, 0, 0, 0)); // year 2000: no monthly partition exists
  const exp = new Date(outside.getTime() + 3_600_000);
  await sql`INSERT INTO budget_reservation ${sql({
    id: "res-oob", workspace_id: "ws_a", budget_account_id: "ba_a", request_id: "req-oob",
    estimated_input_tokens: 1, max_output_tokens: 1, reserved_microusd: 1,
    status: "reserved", expires_at: exp, created_at: outside, window_start: outside,
  })}`;
  // The row must exist and physically reside in the DEFAULT partition, not a monthly one.
  const [row] = await sql`
    SELECT tableoid::regclass::text AS part FROM budget_reservation WHERE id = 'res-oob'
  `;
  assert.equal(row.part, "budget_reservation_default", "out-of-range row must land in the default partition");
});

test("B1: pg_partitioned_table shows exactly 8 RANGE + 1 LIST partitioned tables", async () => {
  const rows = await sql`
    SELECT partstrat::text AS s, count(*)::int AS c
    FROM pg_partitioned_table
    GROUP BY partstrat
  `;
  const by: Record<string, number> = {};
  for (const r of rows) by[r.s] = r.c;
  assert.equal(by["r"], 8, "expected 8 RANGE-partitioned parents");
  assert.equal(by["l"], 1, "expected 1 LIST-partitioned parent (usage_aggregate)");
});

// ---------------------------------------------------------------------------
// 4. ATTACK immutability triggers (§6.15).
// ---------------------------------------------------------------------------

test("immutability: UPDATE on cost_ledger raises IMMUTABLE_ROW", async () => {
  let err: { message?: string } | undefined;
  try {
    await sql`UPDATE cost_ledger SET amount_microusd = 999 WHERE id = 'cl-1'`;
  } catch (e) {
    err = e as { message?: string };
  }
  assert.ok(err, "cost_ledger UPDATE must be blocked");
  assert.match(err!.message ?? "", /IMMUTABLE_ROW/);
});

test("immutability: DELETE on observation raises IMMUTABLE_ROW", async () => {
  let err: { message?: string } | undefined;
  try {
    await sql`DELETE FROM observation WHERE id = 'obs-del'`;
  } catch (e) {
    err = e as { message?: string };
  }
  assert.ok(err, "observation DELETE must be blocked");
  assert.match(err!.message ?? "", /IMMUTABLE_ROW/);
});

test("immutability: observation.compacted false->true is ALLOWED", async () => {
  const res = await sql`UPDATE observation SET compacted = true WHERE id = 'obs-comp'`;
  assert.equal(res.count, 1, "the whitelisted compacted flip must succeed");
  const [row] = await sql`SELECT compacted FROM observation WHERE id = 'obs-comp'`;
  assert.equal(row.compacted, true);
});

test("immutability: gateway_config_revision.status active->superseded is ALLOWED", async () => {
  const res = await sql`UPDATE gateway_config_revision SET status = 'superseded' WHERE id = 'cfg-1'`;
  assert.equal(res.count, 1, "the whitelisted status transition must succeed");
  const [row] = await sql`SELECT status FROM gateway_config_revision WHERE id = 'cfg-1'`;
  assert.equal(row.status, "superseded");
});
