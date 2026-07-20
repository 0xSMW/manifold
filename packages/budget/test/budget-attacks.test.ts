// Adversarial no-oversell tests for @manifold/budget (SPEC §6.7, §8.4, §16.3).
//
// COMMITTED, re-runnable integration tests. Each run spins up its OWN throwaway
// Postgres 16 container (unique name + published loopback port), applies migrations
// 0000 + 0001, then ATTACKS the hard-budget reservation transaction, and tears the
// container down in `after()` even on failure.
//
// THIS IS MONEY. The load-bearing guarantee is test (1): under a 50-way concurrent
// stampede against a budget that fits exactly 10 reservations, EXACTLY 10 succeed, 40 are
// denied with BUDGET_RESERVE_DENIED, and the on-row `reserved` counter NEVER exceeds the
// limit. The service imports the SAME @manifold/database driver surface, @manifold/domain
// money math + state machine, and @manifold/contracts reason codes that production uses.
//
// Container/connection approach mirrors packages/database/test/isolation.test.ts: the pg
// `postgres` driver connects over a published LOOPBACK host port; migrations/seed are
// applied via `docker exec -i … psql -f -` (piping SQL over stdin), which sidesteps any
// driver DDL/dollar-quoting quirks.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

// Import the REAL service under test from its built output (Node type-stripping does not
// resolve .js->.ts sibling imports, so the test drives the compiled dist).
import {
  reserve,
  commit,
  rollback,
  sweepExpired,
  bucketStart,
  ulid,
  BUDGET_RESERVE_DENIED,
} from "../dist/index.js";

type Sql = ReturnType<typeof postgres>;

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "database", "migrations");

const CONTAINER = `mf-budget-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
let HOST_PORT = 0;
let containerStarted = false;
let sql: Sql;

// The hard budgets under attack: cost-unit, each with a limit that fits EXACTLY 10
// reservations of EST. Each test gets its OWN budget account so windows stay isolated
// while honoring the production invariant `window_start = bucketStart(policy, created_at)`
// that commit/rollback/sweep rely on to re-find the counter row.
const WORKSPACE_ID = "ws_budget";
const EST = 1_000_000n; // µ$ per reservation
const CAPACITY = 10n; // reservations that fit
const LIMIT = EST * CAPACITY; // exactly 10 fit; the 11th must be denied

// One monthly account per test (+ a daily account for the fresh-window test). Isolation by
// account, NOT by faking window_start — so commit/rollback resolve the same row reserve did.
const ACCOUNTS: Array<{ id: string; window: string }> = [
  { id: "ba_race", window: "monthly" },
  { id: "ba_idem", window: "monthly" },
  { id: "ba_over", window: "monthly" },
  { id: "ba_huge", window: "monthly" },
  { id: "ba_commit", window: "monthly" },
  { id: "ba_daily", window: "daily" },
  { id: "ba_release", window: "monthly" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function psql(sqlText: string): void {
  try {
    docker(
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
      sqlText,
    );
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`psql failed: ${err.stderr || err.stdout || err.message}`);
  }
}

async function waitForReady(): Promise<void> {
  // Poll with the pg driver itself: the postgres:16 image runs a transient socket-only
  // server during initdb; the published TCP port only answers once the real server is up.
  const deadline = Date.now() + 90_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const probe = postgres({
      host: "127.0.0.1", port: HOST_PORT, database: "postgres",
      username: "postgres", password: "postgres",
      max: 1, connect_timeout: 4, idle_timeout: 1, prepare: false, onnotice: () => {},
    });
    try {
      await probe`select 1`;
      await probe.end({ timeout: 2 });
      return;
    } catch (e) {
      lastErr = e;
      try { await probe.end({ timeout: 1 }); } catch { /* ignore */ }
      await sleep(1000);
    }
  }
  throw new Error(`Postgres never became ready on 127.0.0.1:${HOST_PORT}: ${String(lastErr)}`);
}

before(async () => {
  let started = false;
  let startErr: unknown;
  for (let attempt = 0; attempt < 6 && !started; attempt++) {
    HOST_PORT = 20000 + Math.floor(Math.random() * 40000);
    try {
      docker([
        "run", "-d", "--name", CONTAINER,
        "-p", `127.0.0.1:${HOST_PORT}:5432`,
        "-e", "POSTGRES_PASSWORD=postgres",
        "-e", "POSTGRES_DB=postgres",
        "postgres:16",
      ]);
      started = true;
      containerStarted = true;
    } catch (e) {
      startErr = e;
      try { docker(["rm", "-f", CONTAINER]); } catch { /* ignore */ }
    }
  }
  if (!started) throw new Error(`could not start postgres container: ${String(startErr)}`);

  await waitForReady();

  // Apply BOTH migrations in order (0000 schema, then 0001 partitions + RLS + triggers).
  psql(readFileSync(join(MIGRATIONS_DIR, "0000_tiresome_piledriver.sql"), "utf8"));
  psql(readFileSync(join(MIGRATIONS_DIR, "0001_partitions.sql"), "utf8"));

  // Seed the workspace + one hard budget per test. `hard` requires a
  // pricing_catalog_revision_id (CHECK hard_requires_pricing, §5.2); no FK on that column,
  // so a sentinel id is fine. Distinct scope_id keeps budget_scope_uq satisfied.
  const accountValues = ACCOUNTS.map(
    (a) => `('${a.id}','${WORKSPACE_ID}','app','${a.id}','cost_microusd','${a.window}',` +
      ` ${LIMIT}, 'hard', 'pcr_test')`,
  ).join(",\n      ");
  psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('${WORKSPACE_ID}','ws-budget','Budget WS','local');

    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id)
    VALUES
      ${accountValues};
  `);

  // The service driver: a REAL connection pool (max: 30) so the 50-way stampede genuinely
  // runs transactions in parallel and contends on the SELECT ... FOR UPDATE row lock —
  // not a single serialized connection that would hide an oversell bug. Superuser role
  // (RLS-exempt, models the migration/control-plane path); reserve() still SETs the tenant
  // GUC inside every txn so it is correct under a non-exempt role too.
  sql = postgres({
    host: "127.0.0.1", port: HOST_PORT, database: "postgres",
    username: "postgres", password: "postgres",
    max: 30, prepare: false, onnotice: () => {},
  });
}, { timeout: 180_000 });

after(async () => {
  try { if (sql) await sql.end({ timeout: 5 }); } catch { /* ignore */ }
  if (containerStarted) {
    try { docker(["rm", "-f", CONTAINER]); } catch { /* ignore */ }
  }
});

// The monthly window bucket for "now" — every request minted in this run buckets here.
// It is the SAME value `commit`/`rollback` recompute from the reservation's created_at
// (created_at ≈ now), so a monthly account's reserve/commit/rollback all hit one row.
function monthNow(): Date {
  return bucketStart("monthly", new Date());
}

async function windowRow(
  budgetId: string,
  windowStart: Date,
): Promise<{ reserved: bigint; committed: bigint } | undefined> {
  const rows = await sql<{ reserved_microusd: string; committed_microusd: string }[]>`
    SELECT reserved_microusd, committed_microusd FROM budget_window_state
    WHERE budget_account_id = ${budgetId} AND window_start = ${windowStart} AND shard = 0
  `;
  const r = rows[0];
  return r ? { reserved: BigInt(r.reserved_microusd), committed: BigInt(r.committed_microusd) } : undefined;
}

// ---------------------------------------------------------------------------
// (1) NO OVERSELL under concurrency — the money guarantee.
// ---------------------------------------------------------------------------
test("NO OVERSELL: 50 concurrent reserves against a budget that fits exactly 10 => exactly 10 succeed, 40 denied, SUM(reserved) never exceeds the limit", async () => {
  const budgetId = "ba_race";
  const windowStart = monthNow();
  const N = 50;

  // 50 DISTINCT requests (distinct ULIDs) => 50 genuine reservation attempts, all racing
  // for the same window counter row. est = limit/10, so at most 10 can ever fit.
  const inputs = Array.from({ length: N }, () => ({
    budgetAccountId: budgetId,
    requestId: ulid(),
    estMicroUsd: EST,
    workspaceId: WORKSPACE_ID,
    windowStart,
  }));

  // Fire them all at once — maximum contention on the FOR UPDATE lock.
  const results = await Promise.all(inputs.map((i) => reserve(sql, i)));

  const ok = results.filter((r) => r.ok);
  const denied = results.filter((r) => !r.ok);

  // Every denial is exactly BUDGET_RESERVE_DENIED.
  for (const d of denied) {
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.reason, BUDGET_RESERVE_DENIED);
  }

  assert.equal(ok.length, Number(CAPACITY), `exactly ${CAPACITY} reserves must succeed`);
  assert.equal(denied.length, N - Number(CAPACITY), `the other ${N - Number(CAPACITY)} must be denied`);

  // THE MONEY ASSERTION: the on-row reserved counter must equal exactly 10*est and MUST
  // NOT exceed the limit. If any concurrent reserve had double-bumped or slipped past the
  // guard, this would be > LIMIT. It must never be.
  const row = await windowRow(budgetId, windowStart);
  assert.ok(row, "the window counter row must exist");
  assert.ok(row!.reserved <= LIMIT, `reserved (${row!.reserved}) MUST NOT exceed limit (${LIMIT})`);
  assert.equal(row!.reserved, EST * CAPACITY, "reserved must be exactly 10*est — no oversell, no under-count");

  // And the durable reservation rows agree: exactly 10 'reserved' rows exist.
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM budget_reservation
    WHERE budget_account_id = ${budgetId} AND status = 'reserved'
  `;
  assert.equal(n, Number(CAPACITY), "exactly 10 durable reservations were written");
});

// ---------------------------------------------------------------------------
// (2) Idempotent re-reserve: same requestId returns the same reservation, no double-count.
// ---------------------------------------------------------------------------
test("IDEMPOTENT: re-reserving the same requestId returns the same reservation and does not double-count reserved", async () => {
  const budgetId = "ba_idem";
  const windowStart = monthNow();
  const requestId = ulid();
  const input = {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  };

  const first = await reserve(sql, input);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.idempotentReplay, false, "first reserve is genuinely new");

  const afterFirst = await windowRow(budgetId, windowStart);
  assert.equal(afterFirst!.reserved, EST, "reserved bumped once");

  // Re-reserve the SAME request 5 times concurrently — a retried gateway invocation.
  const replays = await Promise.all(Array.from({ length: 5 }, () => reserve(sql, input)));
  for (const r of replays) {
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.reservationId, first.reservationId, "same reservation id returned");
      assert.equal(r.reservedMicroUsd, EST);
      assert.equal(r.idempotentReplay, true, "replays are flagged idempotent");
    }
  }

  // reserved is STILL exactly one est — never double-counted across 6 total reserves.
  const afterReplays = await windowRow(budgetId, windowStart);
  assert.equal(afterReplays!.reserved, EST, "reserved is still exactly one est — no double count");

  // Exactly one durable reservation row for this request.
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM budget_reservation WHERE request_id = ${requestId}
  `;
  assert.equal(n, 1, "exactly one reservation row for the request");
});

// ---------------------------------------------------------------------------
// (3) Reserve over the limit => denied.
// ---------------------------------------------------------------------------
test("OVER LIMIT: a single reserve larger than the remaining headroom is denied", async () => {
  const budgetId = "ba_over";
  const windowStart = monthNow();

  // A reserve for the whole limit succeeds (fills the window).
  const fill = await reserve(sql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: LIMIT,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(fill.ok, true, "reserving exactly the limit succeeds");

  // One more µ$ over is denied.
  const over = await reserve(sql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: 1n,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(over.ok, false, "a reserve past the limit is denied");
  if (!over.ok) assert.equal(over.reason, BUDGET_RESERVE_DENIED);

  // A reserve strictly larger than the limit on a FRESH budget/window is also denied.
  const hugeBudget = "ba_huge";
  const hugeWindow = monthNow();
  const huge = await reserve(sql, {
    budgetAccountId: hugeBudget, requestId: ulid(), estMicroUsd: LIMIT + 1n,
    workspaceId: WORKSPACE_ID, windowStart: hugeWindow,
  });
  assert.equal(huge.ok, false, "a reserve larger than the limit is denied outright");
  const row = await windowRow(hugeBudget, hugeWindow);
  // Denied reserve leaves the counter at 0 (the upsert row may exist; reserved must be 0).
  assert.equal(row ? row.reserved : 0n, 0n, "denied reserve bumps nothing");
});

// ---------------------------------------------------------------------------
// (4) Commit moves reserved -> committed by the ACTUAL amount.
// ---------------------------------------------------------------------------
test("COMMIT: reconcile moves reserved -> committed by the actual cost", async () => {
  const budgetId = "ba_commit";
  const windowStart = monthNow(); // monthly bucket == commit's derived bucket from created_at
  const requestId = ulid();
  const res = await reserve(sql, {
    budgetAccountId: budgetId, requestId, estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const before = await windowRow(budgetId, windowStart);

  // Reconcile to an ACTUAL that differs from the estimate (real usage came in lower).
  const actual = 600_000n;
  const outcome = await commit(sql, res.reservationId, actual);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "committed");

  const after = await windowRow(budgetId, windowStart);
  // The held estimate is released from reserved; the actual is added to committed.
  assert.equal(after!.reserved, before!.reserved - EST, "the held estimate is released from reserved");
  assert.equal(after!.committed, before!.committed + actual, "committed grows by the actual, not the estimate");

  // Reservation row is terminal + reconciled.
  const [row] = await sql<{ status: string; reconciled_microusd: string }[]>`
    SELECT status, reconciled_microusd FROM budget_reservation WHERE id = ${res.reservationId}
  `;
  assert.equal(row.status, "committed");
  assert.equal(BigInt(row.reconciled_microusd), actual);

  // Idempotent commit: a second reconcile is a no-op (does not move the counters again).
  const again = await commit(sql, res.reservationId, actual);
  assert.equal(again.ok, false, "second commit is a no-op");
  const after2 = await windowRow(budgetId, windowStart);
  assert.equal(after2!.committed, after!.committed, "committed unchanged on replayed commit");
});

// ---------------------------------------------------------------------------
// (5) A NEW WINDOW starts fresh — a full window does not bleed into the next.
// ---------------------------------------------------------------------------
test("NEW WINDOW: a fresh window bucket has full headroom even when another window is full", async () => {
  // A DAILY budget, two distinct UTC-day buckets within the current month (so both land in
  // the current monthly reservation partition). We mint requests with controlled ULID
  // timestamps so each reservation's created_at falls in its target day — the exact same
  // bucket commit/rollback/sweep would recompute (invariant honored).
  const budgetId = "ba_daily";
  const y = new Date().getUTCFullYear();
  const mo = new Date().getUTCMonth();
  const dayA = Date.UTC(y, mo, 1, 12, 0, 0); // 1st of this month, noon UTC
  const dayB = Date.UTC(y, mo, 2, 12, 0, 0); // 2nd of this month, noon UTC
  const wA = bucketStart("daily", new Date(dayA));
  const wB = bucketStart("daily", new Date(dayB));

  // Fill window A (day 1) to its limit.
  const fill = await reserve(sql, {
    budgetAccountId: budgetId, requestId: ulid(dayA), estMicroUsd: LIMIT,
    workspaceId: WORKSPACE_ID, windowStart: wA,
  });
  assert.equal(fill.ok, true);
  // Window A is now full: another reserve into day 1 is denied.
  const aOver = await reserve(sql, {
    budgetAccountId: budgetId, requestId: ulid(dayA), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart: wA,
  });
  assert.equal(aOver.ok, false, "window A (day 1) is full");

  // Window B (day 2) starts fresh: no counter row yet, full headroom.
  assert.equal(await windowRow(budgetId, wB), undefined, "day 2 has no counter row before its first reserve");
  const bFirst = await reserve(sql, {
    budgetAccountId: budgetId, requestId: ulid(dayB), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart: wB,
  });
  assert.equal(bFirst.ok, true, "the new window (day 2) starts fresh and accepts a reserve");
  const bRow = await windowRow(budgetId, wB);
  assert.equal(bRow!.reserved, EST, "day 2 reserved starts from zero + one est");
  assert.equal(bRow!.committed, 0n, "day 2 committed starts at zero");
});

// ---------------------------------------------------------------------------
// (bonus) rollback + sweepExpired release the held reserved (§8.4).
// ---------------------------------------------------------------------------
test("ROLLBACK + SWEEP: released reservations return their held reserved to the window", async () => {
  const budgetId = "ba_release";
  const windowStart = monthNow();

  // rollback releases reserved.
  const r1 = await reserve(sql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
  });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.equal((await windowRow(budgetId, windowStart))!.reserved, EST);
  const rb = await rollback(sql, r1.reservationId);
  assert.equal(rb.ok, true);
  assert.equal(rb.status, "rolled_back");
  assert.equal((await windowRow(budgetId, windowStart))!.reserved, 0n, "rollback releases reserved");

  // sweepExpired releases an already-expired reservation.
  const r2 = await reserve(sql, {
    budgetAccountId: budgetId, requestId: ulid(), estMicroUsd: EST,
    workspaceId: WORKSPACE_ID, windowStart,
    expiresAt: new Date(Date.now() - 60_000), // already past expiry
  });
  assert.equal(r2.ok, true);
  assert.equal((await windowRow(budgetId, windowStart))!.reserved, EST, "reserved held before sweep");
  const swept = await sweepExpired(sql);
  assert.ok(swept >= 1, "at least one expired reservation swept");
  assert.equal((await windowRow(budgetId, windowStart))!.reserved, 0n, "sweep releases the expired hold");
});
