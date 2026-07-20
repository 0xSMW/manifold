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

  // First reservation succeeds.
  await sql`INSERT INTO budget_reservation ${sql({
    id: "res-1", workspace_id: "ws_a", budget_account_id: "ba_a", request_id: "req-1",
    estimated_input_tokens: 10, max_output_tokens: 10, reserved_microusd: 100,
    status: "reserved", expires_at: exp, created_at: ts,
  })}`;

  // Duplicate on (budget_account_id, request_id, created_at) must be rejected.
  let err: { code?: string; message?: string; constraint_name?: string } | undefined;
  try {
    await sql`INSERT INTO budget_reservation ${sql({
      id: "res-2", workspace_id: "ws_a", budget_account_id: "ba_a", request_id: "req-1",
      estimated_input_tokens: 99, max_output_tokens: 99, reserved_microusd: 999,
      status: "reserved", expires_at: exp, created_at: ts,
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

test("B1: reservation with created_at outside any partition raises 'no partition found'", async () => {
  const outside = new Date(Date.UTC(2000, 0, 1, 0, 0, 0)); // year 2000: no partition exists
  const exp = new Date(outside.getTime() + 3_600_000);
  let err: { message?: string } | undefined;
  try {
    await sql`INSERT INTO budget_reservation ${sql({
      id: "res-oob", workspace_id: "ws_a", budget_account_id: "ba_a", request_id: "req-oob",
      estimated_input_tokens: 1, max_output_tokens: 1, reserved_microusd: 1,
      status: "reserved", expires_at: exp, created_at: outside,
    })}`;
  } catch (e) {
    err = e as { message?: string };
  }
  assert.ok(err, "insert into a non-existent partition must fail");
  assert.match(err!.message ?? "", /no partition of relation/i);
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
