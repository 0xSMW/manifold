// RLS-under-the-real-role money tests for @manifold/budget (SPEC §6.16, §8.4, §16.3).
//
// The sibling budget-attacks suite connects as the SUPERUSER `postgres` role, which is
// EXEMPT from row-level security. That masks two money bugs that only bite the production
// path — where the gateway connects as the least-privilege, RLS-SUBJECT `manifold_app`
// role (migration 0002):
//
//   BUG #5 — commit/rollback/sweep locked the budget_reservation row BEFORE setting the
//            tenant GUC. Under RLS the unset GUC hides every row, so the lock found nothing,
//            the call no-op'd as 'expired', and the held `reserved` was NEVER released.
//   BUG #8 — commit/rollback decremented a counter row recomputed as (bucketStart, shard=0),
//            ignoring the actual (window_start, shard) reserve() bumped. For any shard != 0
//            the held `reserved` stranded on the real row forever.
//
// These tests reproduce the production conditions the attacks suite cannot: a genuine
// NON-superuser role for the reserve→commit / reserve→rollback flow (bug #5), and a reserve
// on a non-zero shard (bug #8). Seeding + assertions still use the superuser handle (RLS-
// exempt, the control-plane path); the flows under test run as `budget_app`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { startPg, type PgHarness } from "../../database/test/pg-harness.ts";

import { reserve, commit, rollback, bucketStart, ulid } from "../dist/index.js";

type Sql = ReturnType<typeof postgres>;

let pg: PgHarness;
let sql: Sql; // superuser handle — seeding + RLS-exempt truth reads.
let appSql: Sql; // non-superuser, RLS-SUBJECT handle — the production connection.

const WORKSPACE_ID = "ws_rls";
const EST = 1_000_000n;
const CAPACITY = 10n;
const LIMIT = EST * CAPACITY;
const APP_PW = "budget_app_test_pw";

// Monthly accounts (window_start = bucketStart(policy, created_at) invariant honored).
const ACCOUNTS = ["ba_rls_commit", "ba_rls_rollback", "ba_shard"];

before(async () => {
  pg = await startPg({ poolSize: 8, namePrefix: "mf-budget-rls-test" });
  sql = pg.sql;

  const accountValues = ACCOUNTS.map(
    (id) => `('${id}','${WORKSPACE_ID}','app','${id}','cost_microusd','monthly',` +
      ` ${LIMIT}, 'hard', 'pcr_test')`,
  ).join(",\n      ");

  // Seed the workspace + hard budgets (superuser => RLS-exempt), then create the
  // least-privilege LOGIN role the flows-under-test connect as. It is NOSUPERUSER +
  // NOBYPASSRLS, so every per-workspace RLS policy is load-bearing for it — exactly like
  // the production `manifold_app` role (migration 0002). Grants mirror that role: full DML
  // (RLS then scopes the rows) + sequence access. Password is a fixed test secret.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('${WORKSPACE_ID}','ws-rls','RLS WS','local');

    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id)
    VALUES
      ${accountValues};

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'budget_app') THEN
        CREATE ROLE budget_app LOGIN PASSWORD '${APP_PW}';
      END IF;
    END$$;
    ALTER ROLE budget_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO budget_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO budget_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO budget_app;
  `);

  // A REAL connection pool that logs in AS the non-superuser role — so reserve()/commit()'s
  // OWN transactions run under RLS, precisely the production path.
  const appUrl = pg.url.replace("postgres:postgres@", `budget_app:${APP_PW}@`);
  appSql = postgres(appUrl, { max: 4, prepare: false, onnotice: () => {} });
}, { timeout: 180_000 });

after(async () => {
  if (appSql) { try { await appSql.end({ timeout: 5 }); } catch { /* ignore */ } }
  if (pg) await pg.stop();
});

function monthNow(): Date {
  return bucketStart("monthly", new Date());
}

// Truth read via the SUPERUSER handle (RLS-exempt), addressing an EXACT counter row.
async function windowRow(
  budgetId: string,
  windowStart: Date,
  shard = 0,
): Promise<{ reserved: bigint; committed: bigint } | undefined> {
  const rows = await sql<{ reserved_microusd: string; committed_microusd: string }[]>`
    SELECT reserved_microusd, committed_microusd FROM budget_window_state
    WHERE budget_account_id = ${budgetId} AND window_start = ${windowStart} AND shard = ${shard}
  `;
  const r = rows[0];
  return r ? { reserved: BigInt(r.reserved_microusd), committed: BigInt(r.committed_microusd) } : undefined;
}

// ---------------------------------------------------------------------------
// BUG #5 — commit under the NON-superuser role must actually MOVE money.
// ---------------------------------------------------------------------------
test("RLS COMMIT: reserve+commit under the non-superuser manifold_app-style role actually releases reserved and grows committed (bug #5)", async () => {
  const budgetId = "ba_rls_commit";
  const windowStart = monthNow();
  const requestId = ulid();

  // Reserve as the RLS-subject role (reserve sets the GUC first, so this works today).
  const res = await reserve(appSql, {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(res.ok, true, "reserve under the app role succeeds");
  if (!res.ok) return;

  const before = await windowRow(budgetId, windowStart);
  assert.equal(before!.reserved, EST, "reserved held after reserve");

  // Commit as the SAME RLS-subject role. Under bug #5 the reservation row is invisible at
  // lock time (GUC unset before the lock) => the release no-ops => money never moves.
  const actual = 600_000n;
  const outcome = await commit(appSql, res.reservationId, actual, WORKSPACE_ID);
  assert.equal(outcome.ok, true, "commit under the app role must succeed (bug #5: it silently no-ops)");
  assert.equal(outcome.status, "committed");

  const after = await windowRow(budgetId, windowStart);
  assert.equal(after!.reserved, before!.reserved - EST, "commit RELEASES the held reserved (bug #5)");
  assert.equal(after!.committed, before!.committed + actual, "commit GROWS committed by the actual (bug #5)");

  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM budget_reservation WHERE id = ${res.reservationId}
  `;
  assert.equal(row.status, "committed", "reservation reaches its terminal committed state");
});

// ---------------------------------------------------------------------------
// BUG #5 — rollback under the NON-superuser role must actually RELEASE money.
// ---------------------------------------------------------------------------
test("RLS ROLLBACK: reserve+rollback under the non-superuser role actually releases the held reserved (bug #5)", async () => {
  const budgetId = "ba_rls_rollback";
  const windowStart = monthNow();
  const requestId = ulid();

  const res = await reserve(appSql, {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal((await windowRow(budgetId, windowStart))!.reserved, EST, "reserved held after reserve");

  const rb = await rollback(appSql, res.reservationId, WORKSPACE_ID);
  assert.equal(rb.ok, true, "rollback under the app role must succeed (bug #5: it silently no-ops)");
  assert.equal(rb.status, "rolled_back");

  assert.equal(
    (await windowRow(budgetId, windowStart))!.reserved, 0n,
    "rollback RELEASES the held reserved back to the window (bug #5)",
  );
});

// ---------------------------------------------------------------------------
// BUG #8 — commit must decrement the EXACT (window_start, shard) row reserve bumped.
// ---------------------------------------------------------------------------
test("SHARDED COMMIT: reserve on shard != 0 and commit decrements THAT shard's counter row, not shard 0 (bug #8)", async () => {
  // Superuser handle here isolates this to bug #8 (no RLS interaction): the only variable is
  // WHICH counter row the release addresses. reserve() bumps shard 3; commit must release it.
  const budgetId = "ba_shard";
  const windowStart = monthNow();
  const SHARD = 3;
  const requestId = ulid();

  const res = await reserve(sql, {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart, shard: SHARD,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // reserve bumped the shard-3 row; shard 0 has no row at all.
  assert.equal((await windowRow(budgetId, windowStart, SHARD))!.reserved, EST, "shard 3 holds the reserve");
  assert.equal(await windowRow(budgetId, windowStart, 0), undefined, "shard 0 was never touched");

  const actual = 700_000n;
  const outcome = await commit(sql, res.reservationId, actual, WORKSPACE_ID);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "committed");

  // The held estimate must be released from THE SHARD-3 ROW (bug #8: it decrements shard 0,
  // which does not exist, so shard 3 is stranded at reserved=EST, committed=0 forever).
  const s3 = await windowRow(budgetId, windowStart, SHARD);
  assert.equal(s3!.reserved, 0n, "shard 3 reserved is released (bug #8)");
  assert.equal(s3!.committed, actual, "shard 3 committed grows by the actual (bug #8)");

  // And the release NEVER conjured/altered a shard-0 row.
  assert.equal(await windowRow(budgetId, windowStart, 0), undefined, "shard 0 still has no counter row");
});
