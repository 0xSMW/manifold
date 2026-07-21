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

import {
  reserve,
  commit,
  rollback,
  sweepExpired,
  sweepExpiredForWorkspace,
  bucketStart,
  ulid,
} from "../dist/index.js";

type Sql = ReturnType<typeof postgres>;

let pg: PgHarness;
let sql: Sql; // superuser handle — seeding + RLS-exempt truth reads.
let appSql: Sql; // non-superuser, RLS-SUBJECT handle — the production connection.

const WORKSPACE_ID = "ws_rls";
const EST = 1_000_000n;
const CAPACITY = 10n;
const LIMIT = EST * CAPACITY;
const TOKEN_LIMIT = 10_000n; // token-unit budget cap (bug: token units)
const SHARD_COUNT = 4; // N>1 shards for the sharded-oversell guard test
const APP_PW = "budget_app_test_pw";

// Budget accounts under test. Each honors the window_start = bucketStart(policy, created_at)
// invariant. Defaults: cost_microusd / monthly / LIMIT / no parent — overridable per account.
// `ba_hier_parent` MUST precede `ba_hier_child` so the parent_id FK resolves in one INSERT.
interface AcctSeed { id: string; unit?: string; window?: string; limit?: bigint; parent?: string }
const ACCOUNTS: AcctSeed[] = [
  { id: "ba_rls_commit" },
  { id: "ba_rls_rollback" },
  { id: "ba_shard" },
  { id: "ba_shard_guard" }, // sharded-oversell guard (N=4 shards)
  { id: "ba_terminal" }, // terminal-idempotency
  { id: "ba_rolling", window: "rolling_30d" }, // rolling_30d trailing-sum guard
  { id: "ba_window" }, // caller-controlled window
  { id: "ba_sweep_h1" }, // sweep H1 late-terminal reconcile
  { id: "ba_negative" }, // negative actual clamp
  { id: "ba_tokens", unit: "tokens", limit: TOKEN_LIMIT }, // token-unit guard
  { id: "ba_hier_parent", limit: EST * 5n }, // hierarchical parent (binding cap)
  { id: "ba_hier_child", parent: "ba_hier_parent", limit: EST * 100n }, // hierarchical leaf
  // --- regression-test accounts for the ENGINE fixes (findings 1-5) ---
  { id: "ba_tokens_commit", unit: "tokens", limit: TOKEN_LIMIT }, // finding 1: committed+reserved token guard
  { id: "ba_dl_aparent", limit: EST * 10_000n }, // finding 2: deadlock-order parent (id sorts BEFORE child)
  { id: "ba_dl_zchild", parent: "ba_dl_aparent", limit: EST * 10_000n }, // finding 2: leaf (id sorts AFTER parent)
  { id: "ba_sweep_ws" }, // finding 3: workspace-scoped sweep under the RLS-subject role
  { id: "ba_fresh_shard", limit: EST * 5n }, // finding 4: fresh-shard cross-shard oversell
  { id: "ba_roll_straddle", window: "rolling_30d", limit: EST * 5n }, // finding 5: rolling anchor + no-oversell
  // --- regression account for bug #3 (loadChain cycle detection) ---
  { id: "ba_self_parent", limit: EST * 5n, parent: "ba_self_parent" }, // self-referential parent_id
];

before(async () => {
  pg = await startPg({ poolSize: 8, namePrefix: "mf-budget-rls-test" });
  sql = pg.sql;

  const accountValues = ACCOUNTS.map((a) => {
    const unit = a.unit ?? "cost_microusd";
    const window = a.window ?? "monthly";
    const limit = a.limit ?? LIMIT;
    const parent = a.parent ? `'${a.parent}'` : "NULL";
    return `('${a.id}','${WORKSPACE_ID}','app','${a.id}','${unit}','${window}',` +
      ` ${limit}, 'hard', 'pcr_test', ${parent})`;
  }).join(",\n      ");

  // Seed the workspace + hard budgets (superuser => RLS-exempt), then create the
  // least-privilege LOGIN role the flows-under-test connect as. It is NOSUPERUSER +
  // NOBYPASSRLS, so every per-workspace RLS policy is load-bearing for it — exactly like
  // the production `manifold_app` role (migration 0002). Grants mirror that role: full DML
  // (RLS then scopes the rows) + sequence access. Password is a fixed test secret.
  //
  // The prior-month budget_reservation partitions are created BEFORE the GRANT ON ALL TABLES
  // so the rolling_30d test (which mints reservations on days that may fall in the prior
  // month) can INSERT through the non-superuser role.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('${WORKSPACE_ID}','ws-rls','RLS WS','local');

    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id, parent_id)
    VALUES
      ${accountValues};

    SELECT create_month_partition('budget_reservation', (CURRENT_DATE - INTERVAL '1 month')::date);
    SELECT create_month_partition('budget_reservation', (CURRENT_DATE - INTERVAL '2 months')::date);

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

// Truth read of the TOKEN counters for a window row (superuser, RLS-exempt).
async function windowTokens(
  budgetId: string,
  windowStart: Date,
  shard = 0,
): Promise<{ reserved: bigint; committed: bigint } | undefined> {
  const rows = await sql<{ reserved_tokens: string; committed_tokens: string }[]>`
    SELECT reserved_tokens, committed_tokens FROM budget_window_state
    WHERE budget_account_id = ${budgetId} AND window_start = ${windowStart} AND shard = ${shard}
  `;
  const r = rows[0];
  return r ? { reserved: BigInt(r.reserved_tokens), committed: BigInt(r.committed_tokens) } : undefined;
}

// The UTC-day bucket for `daysAgo` days before now (rolling_30d keeps one row per UTC day).
function dayMs(daysAgo: number): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysAgo, 12, 0, 0);
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

  // reserve bumped the shard-3 row. NOTE (finding 4): reserve now ALSO guarantees a shard-0
  // SERIALIZATION ANCHOR row exists (so concurrent reserves on distinct fresh shards serialize),
  // so shard 0 now exists — but is never bumped: it stays at reserved=0, committed=0.
  assert.equal((await windowRow(budgetId, windowStart, SHARD))!.reserved, EST, "shard 3 holds the reserve");
  const anchorBefore = await windowRow(budgetId, windowStart, 0);
  assert.ok(anchorBefore, "the shard-0 anchor row exists (finding 4)");
  assert.equal(anchorBefore!.reserved, 0n, "the shard-0 anchor holds no reserve");
  assert.equal(anchorBefore!.committed, 0n, "the shard-0 anchor holds no committed");

  const actual = 700_000n;
  const outcome = await commit(sql, res.reservationId, actual, WORKSPACE_ID);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "committed");

  // The held estimate must be released from THE SHARD-3 ROW (bug #8: it decrements shard 0,
  // which does not exist, so shard 3 is stranded at reserved=EST, committed=0 forever).
  const s3 = await windowRow(budgetId, windowStart, SHARD);
  assert.equal(s3!.reserved, 0n, "shard 3 reserved is released (bug #8)");
  assert.equal(s3!.committed, actual, "shard 3 committed grows by the actual (bug #8)");

  // And the release NEVER bumped the shard-0 anchor (it decrements the reservation's OWN shard 3).
  const anchorAfter = await windowRow(budgetId, windowStart, 0);
  assert.ok(anchorAfter, "the shard-0 anchor row still exists");
  assert.equal(anchorAfter!.reserved, 0n, "shard-0 anchor reserved untouched by the release");
  assert.equal(anchorAfter!.committed, 0n, "shard-0 anchor committed untouched by the release");
});

// ---------------------------------------------------------------------------
// SHARDED OVERSELL — the cross-shard headroom guard must sum ALL shards, not
// check the locked shard's row against the FULL limit (~L217).
// ---------------------------------------------------------------------------
test("SHARDED OVERSELL: N=4 shards, concurrent reserves against a budget that fits 10 cannot exceed the limit in total", async () => {
  const budgetId = "ba_shard_guard";
  const windowStart = monthNow();

  // Pre-create all N shard rows (superuser) so every reserve locks the full shard set and no
  // late shard is a phantom — the deterministic no-oversell condition.
  for (let s = 0; s < SHARD_COUNT; s++) {
    await sql`
      INSERT INTO budget_window_state (workspace_id, budget_account_id, window_start, shard)
      VALUES (${WORKSPACE_ID}, ${budgetId}, ${windowStart}, ${s})
      ON CONFLICT DO NOTHING
    `;
  }

  // 40 distinct reserves spread across the 4 shards (10 per shard). Under the bug, each shard's
  // row is checked against the FULL limit, so every shard admits its 10 => 40 succeed (~4x limit).
  const N = 40;
  const inputs = Array.from({ length: N }, (_, i) => ({
    budgetAccountId: budgetId,
    requestId: ulid(),
    estMicroUsd: EST,
    workspaceId: WORKSPACE_ID,
    windowStart,
    shard: i % SHARD_COUNT,
  }));
  const results = await Promise.all(inputs.map((i) => reserve(appSql, i)));
  const okCount = results.filter((r) => r.ok).length;

  // Truth: total reserved across ALL shards must never exceed the limit.
  const [{ total }] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(reserved_microusd), 0)::text AS total FROM budget_window_state
    WHERE budget_account_id = ${budgetId} AND window_start = ${windowStart}
  `;
  assert.ok(
    BigInt(total) <= LIMIT,
    `Σ reserved across shards (${total}) MUST NOT exceed the limit (${LIMIT}) — sharded oversell`,
  );
  assert.equal(BigInt(total), LIMIT, "exactly the limit is reserved across shards — no oversell");
  assert.equal(okCount, Number(CAPACITY), `exactly ${CAPACITY} reserves succeed across all shards`);
});

// ---------------------------------------------------------------------------
// TERMINAL IDEMPOTENCY — a re-reserve of a COMMITTED request must NOT grant a
// fresh hold; it must be denied, not returned ok (~L194).
// ---------------------------------------------------------------------------
test("TERMINAL IDEMPOTENCY: re-reserving a request that already committed is DENIED, not returned ok (no free second dispatch)", async () => {
  const budgetId = "ba_terminal";
  const windowStart = monthNow();
  const requestId = ulid();
  const input = {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  };

  const first = await reserve(appSql, input);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // Terminal-ize the reservation.
  const c = await commit(appSql, first.reservationId, EST, WORKSPACE_ID);
  assert.equal(c.status, "committed");

  // A retried requestId after commit MUST be denied — returning ok here would let the caller
  // dispatch a second time against a hold that no longer exists (free spend).
  const replay = await reserve(appSql, input);
  assert.equal(replay.ok, false, "re-reserving a committed request is DENIED (terminal idempotency)");

  // The window is not re-held by the replay: reserved stayed released, committed unchanged.
  const w = await windowRow(budgetId, windowStart);
  assert.equal(w!.reserved, 0n, "no fresh hold placed by the terminal replay");
  assert.equal(w!.committed, EST, "committed unchanged by the terminal replay");
});

// ---------------------------------------------------------------------------
// ROLLING_30D — headroom is the trailing-30-day sum across the daily rows, not
// just today's fresh bucket (~L104, SPEC §6.7).
// ---------------------------------------------------------------------------
test("ROLLING_30D: headroom is the trailing-30-day sum, so a full 30-day window denies a new reserve even on a fresh day-row", async () => {
  const budgetId = "ba_rolling";

  // Fill the trailing window: one EST on each of 10 distinct UTC days (today-9 .. today-0),
  // oldest first. Each lands in its OWN daily row; the trailing-30d sum reaches exactly LIMIT.
  for (let k = 9; k >= 0; k--) {
    const created = dayMs(k);
    const r = await reserve(appSql, {
      budgetAccountId: budgetId, requestId: ulid(created), estMicroUsd: EST,
      workspaceId: WORKSPACE_ID, windowStart: bucketStart("rolling_30d", new Date(created)),
    });
    assert.equal(r.ok, true, `day-${k} reserve fits the trailing window`);
  }

  // Each day-row individually holds only ONE est — the per-bucket guard would happily admit more.
  const today = bucketStart("rolling_30d", new Date(dayMs(0)));
  assert.equal((await windowRow(budgetId, today))!.reserved, EST, "today's row holds a single est");

  // But the TRAILING-30-DAY sum is already at the limit, so an 11th reserve on today must deny.
  // Under the bug (guards only today's row: EST + EST <= LIMIT) it would be admitted.
  const over = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(dayMs(0)), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart: today,
  });
  assert.equal(over.ok, false, "trailing-30-day sum is full => denied, even though today's row has room");
});

// ---------------------------------------------------------------------------
// CALLER-CONTROLLED WINDOW — reserve must DERIVE window_start from the account's
// window policy, never trust an arbitrary caller value that opens a virgin
// counter (~L148).
// ---------------------------------------------------------------------------
test("CALLER-CONTROLLED WINDOW: a bogus caller windowStart cannot bypass a full real bucket", async () => {
  const budgetId = "ba_window";
  const realWindow = monthNow();

  // Fill the REAL monthly bucket to the limit (honest windowStart).
  for (let i = 0; i < Number(CAPACITY); i++) {
    const r = await reserve(appSql, {
      budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: EST,
      workspaceId: WORKSPACE_ID, windowStart: realWindow,
    });
    assert.equal(r.ok, true);
  }

  // Now attack with a bogus, far-future windowStart. The bug trusts it -> a virgin counter row
  // with full headroom -> the reserve is admitted, blowing the real cap. The fix DERIVES
  // window_start = bucketStart('monthly', created_at) = the real (full) bucket -> denied.
  const bogus = new Date(Date.UTC(2999, 0, 1));
  const attack = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart: bogus,
  });
  assert.equal(attack.ok, false, "a bogus windowStart cannot open a virgin counter past a full bucket");
  assert.equal(await windowRow(budgetId, bogus), undefined, "no counter row was created at the bogus window");
});

// ---------------------------------------------------------------------------
// SWEEP H1 — a terminal cost arriving AFTER a reservation was swept-to-expired
// must still be counted into committed, not zeroed (~L336, SPEC §8.4/H1).
// ---------------------------------------------------------------------------
test("SWEEP H1: commit reconciles an already-expired reservation to actual (late terminal spend is counted, not lost)", async () => {
  const budgetId = "ba_sweep_h1";
  const windowStart = monthNow();
  const requestId = ulid();

  const res = await reserve(appSql, {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
    expiresAt: new Date(Date.now() - 60_000), // already past expiry
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // Sweep it (superuser sweep path): reserved is released to 0, status -> expired.
  const swept = await sweepExpired(sql);
  assert.ok(swept >= 1, "the expired hold is swept");
  const afterSweep = await windowRow(budgetId, windowStart);
  assert.equal(afterSweep!.reserved, 0n, "sweep released the hold");
  assert.equal(afterSweep!.committed, 0n, "nothing committed yet");

  // The terminal cost arrives LATE. commit must reconcile expired -> committed with real spend.
  // Under the bug, commit no-ops on a non-'reserved' reservation, so the spend is lost forever.
  const actual = 800_000n;
  const outcome = await commit(appSql, res.reservationId, actual, WORKSPACE_ID);
  assert.equal(outcome.ok, true, "late-terminal commit reconciles the expired reservation (H1)");
  assert.equal(outcome.status, "committed");

  const afterCommit = await windowRow(budgetId, windowStart);
  assert.equal(afterCommit!.committed, actual, "late terminal spend is counted into committed (H1)");

  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM budget_reservation WHERE id = ${res.reservationId}
  `;
  assert.equal(row.status, "committed", "the reservation moves expired -> committed");
});

// ---------------------------------------------------------------------------
// NEGATIVE ACTUAL — commit must reject/clamp a negative actual so it cannot
// drive committed below zero and free phantom headroom (~L417).
// ---------------------------------------------------------------------------
test("NEGATIVE ACTUAL: a commit with a negative actual is clamped, never driving committed below zero", async () => {
  const budgetId = "ba_negative";
  const windowStart = monthNow();
  const requestId = ulid();

  const res = await reserve(appSql, {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // Reconcile at a NEGATIVE actual. The bug adds it verbatim => committed = -500_000 (negative
  // spend that frees phantom headroom). The fix clamps to 0.
  const outcome = await commit(appSql, res.reservationId, -500_000n, WORKSPACE_ID);
  assert.equal(outcome.committedMicroUsd, 0n, "a negative actual is clamped to 0");

  const after = await windowRow(budgetId, windowStart);
  assert.ok(after!.committed >= 0n, "committed never goes negative");
  assert.equal(after!.committed, 0n, "committed stays at 0, no phantom headroom freed");
  assert.equal(after!.reserved, 0n, "the hold is still released");
});

// ---------------------------------------------------------------------------
// TOKEN UNITS — a token-unit budget must reserve/guard on token counts using
// reserved_tokens/committed_tokens, not compare a µ$ estimate to a token limit (~L213).
// ---------------------------------------------------------------------------
test("TOKEN UNITS: a token-unit budget reserves and guards on reserved_tokens against the token limit", async () => {
  const budgetId = "ba_tokens";
  const windowStart = monthNow();

  // First reserve: 6000 tokens (4000 input + 2000 output). estMicroUsd is deliberately tiny (1)
  // so the buggy µ$ guard trivially passes and never touches the token counters.
  const r1 = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: 1n,
    workspaceId: WORKSPACE_ID, windowStart,
    estimatedInputTokens: 4000n, maxOutputTokens: 2000n,
  });
  assert.equal(r1.ok, true, "the first token reserve fits the token limit");

  // The TOKEN counter must have moved (the bug bumps reserved_microusd instead, leaving this 0).
  assert.equal((await windowTokens(budgetId, windowStart))!.reserved, 6000n, "reserved_tokens bumped by the token estimate");

  // Second reserve of 6000 more tokens => 12000 > 10000 token limit => must be DENIED. The bug
  // guards on µ$ (1 + 1 <= 10000) and admits it, overselling the token cap.
  const r2 = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: 1n,
    workspaceId: WORKSPACE_ID, windowStart,
    estimatedInputTokens: 4000n, maxOutputTokens: 2000n,
  });
  assert.equal(r2.ok, false, "the second token reserve exceeds the TOKEN limit and is denied");
  assert.equal((await windowTokens(budgetId, windowStart))!.reserved, 6000n, "denied token reserve bumps nothing");
});

// ---------------------------------------------------------------------------
// HIERARCHICAL — every ancestor's cap is enforced, not just the leaf's; the
// whole chain is bumped and released (~L142, SPEC §16.3 M13).
// ---------------------------------------------------------------------------
test("HIERARCHICAL: a parent cap denies a leaf reserve even when the leaf has room, and the whole chain is bumped/released", async () => {
  const parentId = "ba_hier_parent"; // limit = 5*EST (the binding cap)
  const childId = "ba_hier_child"; // limit = 100*EST (never the constraint)
  const windowStart = monthNow();

  // Fill the parent via 5 child reserves. Each must bump BOTH the child and the parent counters.
  const reservationIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await reserve(appSql, {
      budgetAccountId: childId, requestId: ulid(), estMicroUsd: EST,
      workspaceId: WORKSPACE_ID, windowStart,
    });
    assert.equal(r.ok, true, `child reserve ${i} fits both caps`);
    if (r.ok) reservationIds.push(r.reservationId);
  }

  // The PARENT counter reflects all five holds (the bug never bumps the parent -> it stays 0).
  assert.equal((await windowRow(parentId, windowStart))!.reserved, EST * 5n, "parent reserved reflects the whole chain");
  assert.equal((await windowRow(childId, windowStart))!.reserved, EST * 5n, "child reserved reflects its holds");

  // A 6th child reserve has ample room at the leaf (5*EST << 100*EST) but the PARENT is full
  // (5*EST == 5*EST). The bug ignores the parent and admits it; the fix denies on the parent cap.
  const over = await reserve(appSql, {
    budgetAccountId: childId, requestId: ulid(), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(over.ok, false, "the parent cap denies the leaf reserve even though the leaf has room");

  // Committing a child reservation releases the hold from BOTH the child AND the parent.
  const done = await commit(appSql, reservationIds[0]!, EST, WORKSPACE_ID);
  assert.equal(done.status, "committed");
  assert.equal((await windowRow(parentId, windowStart))!.reserved, EST * 4n, "commit releases the parent hold too");
  assert.equal((await windowRow(parentId, windowStart))!.committed, EST, "commit grows the parent committed");
});

// ---------------------------------------------------------------------------
// BUG #3 — loadChain has no cycle guard: a self-referential parent_id (parent_id = own id)
// re-joins the SAME row on every recursive step, bounded only by depth < 32, producing 33
// DUPLICATE chain entries for one account. Every downstream bump/release loop iterates the
// chain once per entry, so a single reservation bumps (and releases) that one counter row
// 33 TIMES instead of once — a durable multi-bump that can blow straight past the account's
// own limit on the bump side, and wildly over/under-shoot on the release side.
// ---------------------------------------------------------------------------
test("SELF-PARENT CYCLE (bug #3): a self-referential parent_id bumps/releases the counter row exactly ONCE, not 33x", async () => {
  const budgetId = "ba_self_parent"; // parent_id = itself, limit = 5*EST
  const windowStart = monthNow();
  const requestId = ulid();

  const r = await reserve(appSql, {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  // Under the bug the chain walk visits this one account 33 times (depth 0..32), so the bump
  // loop (step 8 of reserve) adds `est` to the SAME row 33 times: reserved would land at
  // 33*EST — already blowing past the account's own 5*EST limit on a single reserve. The fix
  // (visited-set cycle guard) resolves the chain to length 1, so reserved is bumped exactly
  // once.
  const afterReserve = await windowRow(budgetId, windowStart);
  assert.equal(afterReserve!.reserved, EST, "a single reserve must bump the self-parent row exactly ONCE, not 33x");

  const c = await commit(appSql, r.reservationId, EST, WORKSPACE_ID);
  assert.equal(c.status, "committed");

  // Same argument on release: under the bug, releaseReservation's chain walk also visits the
  // account 33 times, so committed would land at 33*EST instead of EST.
  const afterCommit = await windowRow(budgetId, windowStart);
  assert.equal(afterCommit!.reserved, 0n, "release brings reserved back to exactly zero, not a 33x-scaled value");
  assert.equal(afterCommit!.committed, EST, "commit must grow committed by exactly one actual, not 33x");
});

// ---------------------------------------------------------------------------
// FINDING 1 — a token-unit hard budget must count COMMITTED tokens (not just
// reserved) in its guard: committed + reserved + est ≤ token limit.
// ---------------------------------------------------------------------------
test("TOKEN COMMITTED+RESERVED (finding 1): a token budget denies once committed + reserved + est would exceed the limit", async () => {
  const budgetId = "ba_tokens_commit"; // unit=tokens, limit=10_000
  const windowStart = monthNow();

  // Reserve 6000 tokens, then COMMIT them with actualTokens=6000 -> committed_tokens=6000, hold freed.
  const r1 = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: 1n,
    workspaceId: WORKSPACE_ID, windowStart,
    estimatedInputTokens: 4000n, maxOutputTokens: 2000n,
  });
  assert.equal(r1.ok, true, "the first token reserve fits");
  if (!r1.ok) return;
  const c = await commit(appSql, r1.reservationId, 1n, WORKSPACE_ID, 6000n);
  assert.equal(c.status, "committed");
  const t1 = await windowTokens(budgetId, windowStart);
  assert.equal(t1!.committed, 6000n, "committed_tokens grew by the actual tokens");
  assert.equal(t1!.reserved, 0n, "the token hold was released on commit");

  // committed(6000) + reserved(0) + 4000 = 10000 == limit -> the boundary reserve is admitted.
  const r2 = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: 1n,
    workspaceId: WORKSPACE_ID, windowStart,
    estimatedInputTokens: 3000n, maxOutputTokens: 1000n, // 4000 tokens
  });
  assert.equal(r2.ok, true, "committed + reserved exactly at the token limit is admitted");

  // Now committed(6000) + reserved(4000) = 10000; a single further token would exceed -> DENIED.
  // The guard MUST sum committed_tokens too, not just reserved_tokens.
  const r3 = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: 1n,
    workspaceId: WORKSPACE_ID, windowStart,
    estimatedInputTokens: 1n, maxOutputTokens: 0n,
  });
  assert.equal(r3.ok, false, "committed + reserved already at the token limit -> a further token reserve is denied");
  assert.equal((await windowTokens(budgetId, windowStart))!.reserved, 4000n, "the denied token reserve bumped nothing");
});

// ---------------------------------------------------------------------------
// FINDING 2 — reserve() locks the chain id-ASC; release (commit/rollback/sweep)
// must take its chain locks in the SAME id-ASC order, or a reserve racing a
// release on a hierarchy deadlocks. Here the parent id sorts BEFORE the child, so
// id-ASC order (parent→child) is the OPPOSITE of the old leaf→root release order.
// ---------------------------------------------------------------------------
test("DEADLOCK ORDERING (finding 2): concurrent reserve and commit/rollback on a hierarchy never deadlock", async () => {
  const childId = "ba_dl_zchild"; // leaf; id sorts AFTER the parent
  const windowStart = monthNow();

  // Pre-create reservations to release CONCURRENTLY with fresh reserves.
  const pre: string[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await reserve(appSql, {
      budgetAccountId: childId, requestId: ulid(), estMicroUsd: EST,
      workspaceId: WORKSPACE_ID, windowStart,
    });
    assert.equal(r.ok, true);
    if (r.ok) pre.push(r.reservationId);
  }

  // Fresh reserves lock parent→child (id-ASC); releases now lock parent→child too (finding 2 fix),
  // so no reserve/release pair can form the parent↔child lock cycle that used to deadlock. Fire
  // them all at once and require every op to complete without error.
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 24; i++) {
    ops.push(reserve(appSql, {
      budgetAccountId: childId, requestId: ulid(), estMicroUsd: EST,
      workspaceId: WORKSPACE_ID, windowStart,
    }));
  }
  pre.forEach((id, i) => {
    ops.push(i % 2 === 0
      ? commit(appSql, id, EST, WORKSPACE_ID)
      : rollback(appSql, id, WORKSPACE_ID));
  });

  const settled = await Promise.allSettled(ops);
  const deadlocks = settled.filter(
    (s) => s.status === "rejected" && /deadlock/i.test(String((s as PromiseRejectedResult).reason)),
  );
  assert.equal(deadlocks.length, 0, "no transaction deadlocked (reserve and release share the id-ASC lock order)");
  assert.equal(
    settled.filter((s) => s.status === "rejected").length, 0,
    "every reserve/commit/rollback completed without error",
  );
});

// ---------------------------------------------------------------------------
// FINDING 3 — the unscoped all-workspaces sweep needs a BYPASSRLS/owner role; run
// as an RLS-subject role it sees zero rows. sweepExpiredForWorkspace sets the tenant
// GUC in the discovery transaction and works under the RLS-subject role.
// ---------------------------------------------------------------------------
test("SWEEP RLS (finding 3): unscoped sweep is RLS-blind as a subject role; the workspace-scoped sweep releases the hold", async () => {
  const budgetId = "ba_sweep_ws";
  const windowStart = monthNow();
  const res = await reserve(appSql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
    expiresAt: new Date(Date.now() - 60_000), // already past expiry
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal((await windowRow(budgetId, windowStart))!.reserved, EST, "hold held before sweep");

  // Unscoped sweep AS the RLS-subject role: its discovery SELECT sets no tenant GUC, so FORCE-RLS
  // filters every row out -> it releases nothing and the hold is stranded (finding 3).
  const blind = await sweepExpired(appSql);
  assert.equal(blind, 0, "unscoped sweep as an RLS-subject role sees no rows and releases nothing");
  assert.equal(
    (await windowRow(budgetId, windowStart))!.reserved, EST,
    "the hold is still stranded after the RLS-blind unscoped sweep",
  );

  // Workspace-scoped entrypoint sets the GUC in the discovery txn -> finds and releases the hold.
  const scoped = await sweepExpiredForWorkspace(appSql, WORKSPACE_ID);
  assert.ok(scoped >= 1, "workspace-scoped sweep releases the expired hold under the RLS-subject role");
  assert.equal(
    (await windowRow(budgetId, windowStart))!.reserved, 0n,
    "the hold is released after the workspace-scoped sweep",
  );
});

// ---------------------------------------------------------------------------
// FINDING 4 — two reserves on DISTINCT brand-new shard rows must not each admit the
// full limit. The shard-0 anchor serializes them. (Unlike the SHARDED OVERSELL test,
// the shard rows are NOT pre-created — this is the fresh-shard race.)
// ---------------------------------------------------------------------------
test("FRESH-SHARD OVERSELL (finding 4): concurrent reserves on distinct brand-new shards cannot exceed the limit", async () => {
  const budgetId = "ba_fresh_shard"; // limit = 5*EST
  const windowStart = monthNow();
  const CAP = 5n;

  // 20 reserves spread across 4 shards (5 per shard), all fresh — no shard row pre-created. Under
  // the bug each reserve is first to touch its shard, locks a disjoint set, sums only its own
  // uncommitted row and admits -> ~4x oversell. The anchor forces them to serialize on shard 0.
  const N = 20;
  const inputs = Array.from({ length: N }, (_, i) => ({
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart, shard: i % SHARD_COUNT,
  }));
  const results = await Promise.all(inputs.map((i) => reserve(appSql, i)));
  const okCount = results.filter((r) => r.ok).length;

  const [{ total }] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(reserved_microusd), 0)::text AS total FROM budget_window_state
    WHERE budget_account_id = ${budgetId} AND window_start = ${windowStart}
  `;
  assert.ok(
    BigInt(total) <= EST * CAP,
    `Σ reserved across fresh shards (${total}) MUST NOT exceed the limit (${EST * CAP})`,
  );
  assert.equal(BigInt(total), EST * CAP, "exactly the limit is reserved across the fresh shards — no oversell");
  assert.equal(okCount, Number(CAP), "exactly 5 reserves succeed across all fresh shards");
});

// ---------------------------------------------------------------------------
// FINDING 5 — rolling_30d guards on the trailing-30-day SUM but reserve locks only
// today's row (lock granularity < guard granularity). The fix serializes every rolling
// reserve on a CANONICAL epoch-sentinel anchor row (independent of which UTC-day row it
// bumps), so concurrent reserves compute the trailing sum against committed — never stale —
// state. This asserts (a) the anchor mechanism is in place and never pollutes the guard, and
// (b) concurrent same-window reserves cannot oversell the trailing-30-day limit.
//
// NOTE: a fully deterministic CROSS-day concurrent admit-count is not possible — a rolling
// window ending at an EARLIER day legitimately excludes LATER days, so the admit count of a
// multi-day concurrent batch is order-dependent by definition. The deterministic guarantees the
// anchor provides are exactly the two asserted below.
// ---------------------------------------------------------------------------
test("ROLLING ANCHOR (finding 5): rolling reserves serialize on a canonical anchor row (excluded from the guard) and concurrent same-window reserves cannot oversell the trailing limit", async () => {
  const budgetId = "ba_roll_straddle"; // rolling_30d, limit = 5*EST
  const today = bucketStart("rolling_30d", new Date(dayMs(0)));
  const EPOCH = new Date(0);

  // Pre-commit EST on two PRIOR days within the trailing window (sequential). Each lands in its
  // OWN daily row — DISTINCT from today's row — so the trailing sum as of today starts at 2*EST
  // while today's row is still empty: exactly the lock-vs-guard granularity gap finding 5 targets.
  for (const d of [2, 4]) {
    const created = dayMs(d);
    const r = await reserve(appSql, {
      budgetAccountId: budgetId, requestId: ulid(created), estMicroUsd: EST,
      workspaceId: WORKSPACE_ID, windowStart: bucketStart("rolling_30d", new Date(created)),
    });
    assert.equal(r.ok, true, `prior-day-${d} reserve fits`);
    if (r.ok) await commit(appSql, r.reservationId, EST, WORKSPACE_ID);
  }

  // (a) The canonical epoch anchor row exists (the per-account serialization point) and is NEVER
  //     bumped — it holds zero counters and sits below the trailing lower bound, so it can never
  //     pollute the guard sum.
  const anchor = await windowRow(budgetId, EPOCH, 0);
  assert.ok(anchor, "the canonical epoch anchor row exists for the rolling account (finding 5)");
  assert.equal(anchor!.reserved, 0n, "the anchor holds no reserve");
  assert.equal(anchor!.committed, 0n, "the anchor holds no committed");

  // (b) Fire 10 concurrent reserves dated TODAY. The guard sums the WHOLE trailing window (today's
  //     row + the two prior day-rows = 2*EST committed), leaving room for exactly 3 more (limit
  //     5*EST). All reserves serialize on the anchor, so each sees committed state — no oversell.
  const inputs = Array.from({ length: 10 }, () => ({
    budgetAccountId: budgetId, requestId: ulid(dayMs(0)), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart: today,
  }));
  const results = await Promise.all(inputs.map((i) => reserve(appSql, i)));
  const okCount = results.filter((r) => r.ok).length;

  const lower = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  const [{ total }] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(committed_microusd + reserved_microusd), 0)::text AS total
    FROM budget_window_state
    WHERE budget_account_id = ${budgetId} AND window_start >= ${lower} AND window_start <= ${today}
  `;
  assert.ok(
    BigInt(total) <= EST * 5n,
    `trailing-30d Σ (${total}) MUST NOT exceed the limit (${EST * 5n}) — rolling oversell`,
  );
  assert.equal(BigInt(total), EST * 5n, "exactly the limit is reserved across the trailing window");
  assert.equal(okCount, 3, "exactly 3 of the concurrent today-reserves fit the remaining trailing headroom");
});
