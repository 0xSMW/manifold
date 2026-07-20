// packages/budget/src/index.ts — @manifold/budget public entrypoint.
//
// The hard-budget reservation service: the ONE strong-consistency point on the
// enterprise hot path (SPEC §16.3). `reserve` is a single short transaction that
// touches one `budget_window_state` shard row under `FOR UPDATE`, guards
// `committed + reserved + est ≤ limit`, bumps `reserved`, and inserts an idempotent
// `budget_reservation`. `commit`/`rollback`/`sweepExpired` implement the §8.4
// lifecycle (`reserved → committed | rolled_back | expired`).
//
// This package depends only on @manifold/database (for the `Sql` transaction surface —
// the driver import boundary lives there, SPEC §4.2), @manifold/domain (money math +
// the reservation state machine), and @manifold/contracts (the reason-code registry).
// It NEVER imports drizzle-orm / postgres directly.
import type { Sql, TransactionSql } from "@manifold/database";
import { REASON_CODES } from "@manifold/contracts";
import {
  costMicroUsd,
  transitionBudgetReservation,
  type BudgetReservationState,
  type MicroUsd,
} from "@manifold/domain";

import { ulid, ulidCreatedAt } from "./ulid.js";

export { ulid, ulidCreatedAt, ulidTimeMs } from "./ulid.js";

/** The single reason a hard reserve denies. Pinned to the §0.2 registry. */
export const BUDGET_RESERVE_DENIED = "BUDGET_RESERVE_DENIED" satisfies
  (typeof REASON_CODES)[number];

/** N=1 by default (SPEC §16.3 H2): a budget fans across shards only when its measured
 *  reserve rate approaches the single-row ceiling. Unsharded budgets always use shard 0. */
const DEFAULT_SHARD = 0;

/** Default reservation TTL. Real callers pass `expires_at ≥ route.overall_ms` so a
 *  reservation never expires mid-stream (§8.4); one hour is the safe default here. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Bind a bigint (µ$ / tokens) as its decimal string. postgres-js serializes JS strings
 * as unknown-typed parameters, which Postgres coerces to `bigint` from column/operator
 * context — so int8 arithmetic and inserts stay exact without a float ever appearing.
 */
const p = (b: bigint): string => b.toString();

export interface ReserveInput {
  budgetAccountId: string;
  /** Gateway trace-id ULID; the idempotency anchor and the source of `created_at`. */
  requestId: string;
  /** Pre-dispatch cost estimate in µ$ (§6.10): input_est·input_price + max_output·output_price. */
  estMicroUsd: MicroUsd;
  workspaceId: string;
  /** Fixed-window bucket start (sentinel epoch for `total`); identifies the counter row. */
  windowStart: Date;
  /** Sub-counter shard; defaults to 0 (unsharded). */
  shard?: number;
  /** Reservation expiry; defaults to created_at + 1h. */
  expiresAt?: Date;
  estimatedInputTokens?: bigint;
  maxOutputTokens?: bigint;
}

export type ReserveResult =
  | { ok: true; reservationId: string; reservedMicroUsd: MicroUsd; idempotentReplay: boolean }
  | { ok: false; reason: typeof BUDGET_RESERVE_DENIED };

interface WindowRow {
  committed_microusd: string;
  reserved_microusd: string;
  committed_tokens: string;
  reserved_tokens: string;
}

interface AccountRow {
  limit_amount: string;
  workspace_id: string;
}

interface ReservationRow {
  id: string;
  workspace_id: string;
  budget_account_id: string;
  reserved_microusd: string;
  status: BudgetReservationState;
  created_at: Date;
  /** The EXACT counter-row coordinates reserve() bumped (§16.3), persisted on the row so
   *  commit/rollback/sweep decrement THAT row instead of re-deriving (bucketStart, shard=0). */
  window_start: Date;
  shard: number;
}

/**
 * The fixed-window bucket start for `instant` under a budget's `window` policy
 * (SPEC §6.7 window semantics). `window_start` is a pure function of (policy, instant),
 * so `reserve`, `commit`, `rollback`, and `sweepExpired` all resolve the SAME counter row
 * without threading `windowStart` through every call. All boundaries are UTC.
 */
export function bucketStart(window: string, instant: Date): Date {
  const d = instant;
  switch (window) {
    case "total":
      return new Date(0); // sentinel 'epoch' — one row accumulates forever
    case "daily":
    case "rolling_30d": // rolling keeps one row per UTC day; this is today's row
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    case "weekly": {
      const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dow = (day.getUTCDay() + 6) % 7; // days since Monday
      day.setUTCDate(day.getUTCDate() - dow);
      return day;
    }
    case "monthly":
    default:
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
}

/**
 * Reserve `estMicroUsd` against a hard budget. Returns the created (or, on replay, the
 * pre-existing) reservation, or `{ ok:false, reason:'BUDGET_RESERVE_DENIED' }` when the
 * window has no headroom.
 *
 * The transaction is exactly SPEC §16.3, with idempotency made money-safe (the
 * `reserved` bump happens ONLY on a genuinely new reservation, never on an idempotent
 * replay, so a retried request can never double-count):
 *
 *   BEGIN
 *   INSERT budget_window_state (…, shard) VALUES (…) ON CONFLICT DO NOTHING   -- upsert-first (M14)
 *   SELECT … FROM budget_window_state WHERE … AND shard=$shard FOR UPDATE     -- lock the shard row
 *   -- idempotent replay? return the existing reservation, DO NOT re-bump
 *   -- guard: committed + reserved + est ≤ limit  else ROLLBACK → BUDGET_RESERVE_DENIED
 *   INSERT budget_reservation (…, created_at=$ulidTs, status='reserved')
 *          ON CONFLICT (budget_account_id, request_id, created_at) DO NOTHING
 *   UPDATE budget_window_state SET reserved_microusd = reserved_microusd + $est
 *   COMMIT
 *
 * The `FOR UPDATE` lock on the one `(budget, window_start, shard)` row is the
 * serialization point: it serializes both capacity checks (no oversell) AND same-request
 * replays (no double-count), because a second txn for the same request blocks until the
 * first COMMITs and then sees the committed reservation row.
 */
export async function reserve(db: Sql, input: ReserveInput): Promise<ReserveResult> {
  const {
    budgetAccountId,
    requestId,
    estMicroUsd,
    workspaceId,
    windowStart,
    shard = DEFAULT_SHARD,
  } = input;

  const createdAt = ulidCreatedAt(requestId);
  const expiresAt = input.expiresAt ?? new Date(createdAt.getTime() + DEFAULT_TTL_MS);
  const est = BigInt(estMicroUsd);

  return db.begin(async (sql: TransactionSql): Promise<ReserveResult> => {
    // Tenant scope for RLS (§6.16); harmless (and correct) whether or not the caller
    // connects as an RLS-exempt role.
    await sql`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;

    // 1. Upsert the counter row FIRST so a just-opened window can't race two
    //    first-requests into an oversell (M14). ON CONFLICT DO NOTHING — never clobbers.
    await sql`
      INSERT INTO budget_window_state (workspace_id, budget_account_id, window_start, shard)
      VALUES (${workspaceId}, ${budgetAccountId}, ${windowStart}, ${shard})
      ON CONFLICT DO NOTHING
    `;

    // 2. Lock THIS shard row. Every reserve for (budget, window, shard) serializes here.
    const windowRows = await sql<WindowRow[]>`
      SELECT committed_microusd, reserved_microusd, committed_tokens, reserved_tokens
      FROM budget_window_state
      WHERE budget_account_id = ${budgetAccountId}
        AND window_start = ${windowStart}
        AND shard = ${shard}
      FOR UPDATE
    `;
    const win = windowRows[0];
    if (!win) {
      // Cannot happen after the upsert unless RLS hid the row (misconfigured tenant).
      return { ok: false, reason: BUDGET_RESERVE_DENIED };
    }

    // 3. Idempotent replay: a reservation for (budget, request, created_at) already
    //    exists → return it unchanged, WITHOUT re-bumping `reserved` (§8.4, §16.1).
    const existingRows = await sql<ReservationRow[]>`
      SELECT id, workspace_id, budget_account_id, reserved_microusd, status, created_at
      FROM budget_reservation
      WHERE budget_account_id = ${budgetAccountId}
        AND request_id = ${requestId}
        AND created_at = ${createdAt}
    `;
    const existing = existingRows[0];
    if (existing) {
      return {
        ok: true,
        reservationId: existing.id,
        reservedMicroUsd: BigInt(existing.reserved_microusd),
        idempotentReplay: true,
      };
    }

    // 4. Read the hard limit and headroom (N=1 → single shard; the sharded sum is a
    //    trivial extension). Guard committed + reserved + est ≤ limit.
    const accountRows = await sql<AccountRow[]>`
      SELECT limit_amount, workspace_id
      FROM budget_account
      WHERE id = ${budgetAccountId}
    `;
    const account = accountRows[0];
    if (!account) return { ok: false, reason: BUDGET_RESERVE_DENIED };

    const limit = BigInt(account.limit_amount);
    const committed = BigInt(win.committed_microusd);
    const reserved = BigInt(win.reserved_microusd);

    if (committed + reserved + est > limit) {
      // No headroom. `begin` rolls back the (idempotent) upsert; nothing is bumped.
      return { ok: false, reason: BUDGET_RESERVE_DENIED };
    }

    // 5. Create the reservation. ON CONFLICT DO NOTHING keeps it idempotent even against
    //    a racing insert; under our FOR UPDATE lock the existing-row check above already
    //    guarantees this is genuinely new, so the insert always writes here.
    const reservationId = ulid(createdAt.getTime());
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO budget_reservation (
        id, workspace_id, budget_account_id, request_id,
        estimated_input_tokens, max_output_tokens,
        reserved_microusd, status, expires_at, created_at,
        window_start, shard
      ) VALUES (
        ${reservationId}, ${workspaceId}, ${budgetAccountId}, ${requestId},
        ${p(input.estimatedInputTokens ?? 0n)}, ${p(input.maxOutputTokens ?? 0n)},
        ${p(est)}, 'reserved', ${expiresAt}, ${createdAt},
        ${windowStart}, ${shard}
      )
      ON CONFLICT (budget_account_id, request_id, created_at) DO NOTHING
      RETURNING id
    `;
    if (!inserted[0]) {
      // Lost an insert race for the same request under a concurrent tenant-exempt path:
      // re-read and return the winner without bumping (still no double-count).
      const raced = await sql<ReservationRow[]>`
        SELECT id, reserved_microusd FROM budget_reservation
        WHERE budget_account_id = ${budgetAccountId}
          AND request_id = ${requestId}
          AND created_at = ${createdAt}
      `;
      const w = raced[0]!;
      return {
        ok: true,
        reservationId: w.id,
        reservedMicroUsd: BigInt(w.reserved_microusd),
        idempotentReplay: true,
      };
    }

    // 6. Bump the outstanding reservation — ONLY for a genuinely new reservation.
    await sql`
      UPDATE budget_window_state
      SET reserved_microusd = reserved_microusd + ${p(est)}, updated_at = now()
      WHERE budget_account_id = ${budgetAccountId}
        AND window_start = ${windowStart}
        AND shard = ${shard}
    `;

    return { ok: true, reservationId, reservedMicroUsd: est, idempotentReplay: false };
  });
}

export interface CommitResult {
  ok: boolean;
  status: BudgetReservationState;
  committedMicroUsd: MicroUsd;
}

/**
 * Reconcile a reservation to its actual cost (§8.4 `reserved → committed`): release the
 * held `reserved` and add `actualMicroUsd` to `committed`, all under the window row lock.
 * Idempotent: a reservation that is no longer `reserved` is returned unchanged.
 *
 * `workspaceId` scopes RLS for this transaction and MUST be supplied whenever the caller
 * connects as an RLS-subject role (the production `manifold_app` path, §6.16): it sets the
 * tenant GUC BEFORE the reservation is locked, so the row is visible to the lock (bug #5).
 * It is optional only for RLS-exempt callers (migrations / tests as superuser).
 */
export async function commit(
  db: Sql,
  reservationId: string,
  actualMicroUsd: MicroUsd,
  workspaceId?: string,
): Promise<CommitResult> {
  const actual = BigInt(actualMicroUsd);
  return db.begin(async (sql: TransactionSql): Promise<CommitResult> => {
    const out = await releaseReservation(sql, reservationId, "RECONCILE", { actual, workspaceId });
    switch (out.kind) {
      case "released":
        return { ok: true, status: out.status, committedMicroUsd: actual };
      case "missing":
        return { ok: false, status: "expired", committedMicroUsd: 0n };
      case "noop":
        // Already terminal — no-op (idempotent reconcile); echoes the requested actual.
        return { ok: false, status: out.status, committedMicroUsd: actual };
      case "blocked":
        return { ok: false, status: out.status, committedMicroUsd: 0n };
    }
  });
}

/**
 * Roll a reservation back (§8.4 `reserved → rolled_back`): release the held `reserved`,
 * add nothing to `committed`. Idempotent on a non-`reserved` reservation.
 *
 * `workspaceId` scopes RLS for this transaction (see `commit`): pass it whenever the caller
 * connects as an RLS-subject role, so the reservation is visible to its lock (bug #5).
 */
export async function rollback(
  db: Sql,
  reservationId: string,
  workspaceId?: string,
): Promise<{ ok: boolean; status: BudgetReservationState }> {
  return db.begin(async (sql: TransactionSql): Promise<{ ok: boolean; status: BudgetReservationState }> => {
    const out = await releaseReservation(sql, reservationId, "ROLLBACK", { workspaceId });
    return { ok: out.kind === "released", status: out.status };
  });
}

/**
 * Sweep reservations past `expires_at` (§8.4 `reserved → expired`), releasing their
 * held `reserved`. This is the "no terminal Observation ever produced" release path —
 * the reconcile-to-actual-if-terminal-exists (H1) variant belongs to the reconcile job
 * (§17.2), which has the Observation table this money-core does not. Returns the count
 * of reservations expired.
 */
export async function sweepExpired(db: Sql, now: Date = new Date()): Promise<number> {
  // Find expired holds first (short read), then release each under its window lock. Carry
  // each row's workspace_id so the release can set the tenant GUC BEFORE locking the row
  // (bug #5) — required whenever the sweep runs as an RLS-subject role.
  const expired = await db<{ id: string; created_at: Date; workspace_id: string }[]>`
    SELECT id, created_at, workspace_id FROM budget_reservation
    WHERE status = 'reserved' AND expires_at < ${now}
  `;
  let count = 0;
  for (const row of expired) {
    const done = await db.begin(async (sql: TransactionSql): Promise<boolean> => {
      const out = await releaseReservation(sql, row.id, "EXPIRE", { workspaceId: row.workspace_id });
      return out.kind === "released";
    });
    if (done) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The disjoint outcomes of `releaseReservation`, letting each caller map to its own result
 * shape while the release skeleton stays in one place:
 *   - `released` — the transition applied; `status` is the new terminal state.
 *   - `missing`  — no such reservation row (treated as `expired` by callers).
 *   - `noop`     — the reservation is already terminal; `status` is its current state.
 *   - `blocked`  — the domain machine rejected the transition (status still `reserved`).
 */
type ReleaseOutcome =
  | { kind: "released"; status: BudgetReservationState }
  | { kind: "missing"; status: "expired" }
  | { kind: "noop"; status: BudgetReservationState }
  | { kind: "blocked"; status: BudgetReservationState };

/**
 * The shared release skeleton behind commit / rollback / sweepExpired (§8.4). Under the
 * reservation's row lock it: scopes the tenant GUC, requires the reservation still be
 * `reserved`, runs the domain state transition for `event`, subtracts the held estimate
 * from `reserved_microusd` in the window counter, and flips the reservation to its terminal
 * state. `RECONCILE` (commit) additionally passes `actual`, which is added to
 * `committed_microusd` and stamped onto `reconciled_microusd`; the other paths pass nothing
 * and leave `committed_microusd` / `reconciled_microusd` untouched. MUST run inside a
 * `db.begin` transaction — the caller owns BEGIN/COMMIT.
 */
async function releaseReservation(
  sql: TransactionSql,
  reservationId: string,
  event: "RECONCILE" | "ROLLBACK" | "EXPIRE",
  opts: { actual?: bigint; workspaceId?: string } = {},
): Promise<ReleaseOutcome> {
  // Scope the tenant GUC FIRST — BEFORE the lock — so the reservation row is visible to the
  // FOR UPDATE lock under RLS (bug #5). Without this, an RLS-subject role locks 0 rows and
  // the release silently no-ops, permanently stranding the held `reserved`. Mirrors reserve(),
  // which also sets the GUC before touching any RLS-protected row. RLS-exempt callers may
  // omit it (the lock sees the row regardless); we then fall back to the row's own workspace.
  if (opts.workspaceId !== undefined) {
    await sql`SELECT set_config('manifold.workspace_id', ${opts.workspaceId}, true)`;
  }
  const res = await lockReservation(sql, reservationId);
  if (!res) return { kind: "missing", status: "expired" };
  await sql`SELECT set_config('manifold.workspace_id', ${res.workspace_id}, true)`;
  if (res.status !== "reserved") return { kind: "noop", status: res.status };

  // Domain state machine is the source of truth for the legal transition. (`event` is a
  // union of literal tags; re-narrow it to the discriminated event the machine expects.)
  const next = transitionBudgetReservation(
    "reserved",
    { type: event } as Parameters<typeof transitionBudgetReservation>[1],
  );
  if (!next.ok) return { kind: "blocked", status: res.status };

  const held = BigInt(res.reserved_microusd);
  const actual = opts.actual ?? 0n; // rollback/sweep add nothing to committed
  // Move held → committed adjusted to actual, in the counter row (§16.3). For the
  // release-only paths `actual` is 0, so `committed_microusd` is written back unchanged.
  await sql`
    UPDATE budget_window_state
    SET reserved_microusd = reserved_microusd - ${p(held)},
        committed_microusd = committed_microusd + ${p(actual)},
        updated_at = now()
    WHERE budget_account_id = ${res.budget_account_id}
      AND window_start = ${res.window_start}
      AND shard = ${res.shard}
  `;
  // Only commit stamps reconciled_microusd; rollback/sweep leave it as-is (COALESCE keeps
  // the existing value when `actual` was not supplied).
  const reconciled = opts.actual !== undefined ? p(opts.actual) : null;
  await sql`
    UPDATE budget_reservation
    SET status = ${next.state},
        reconciled_microusd = COALESCE(${reconciled}, reconciled_microusd),
        reconciled_at = now()
    WHERE id = ${reservationId} AND created_at = ${res.created_at}
  `;
  return { kind: "released", status: next.state };
}

/**
 * Lock a reservation row FOR UPDATE by id (ULID → practically unique across partitions).
 * Reads the persisted (window_start, shard) so commit/rollback/sweep decrement the EXACT
 * counter row reserve() bumped (§16.3) — no re-derivation, no budget_account join needed.
 */
async function lockReservation(sql: TransactionSql, reservationId: string): Promise<ReservationRow | undefined> {
  const rows = await sql<ReservationRow[]>`
    SELECT id, workspace_id, budget_account_id, reserved_microusd,
           status, created_at, window_start, shard
    FROM budget_reservation
    WHERE id = ${reservationId}
    FOR UPDATE
  `;
  return rows[0];
}

/** Estimate reservation cost in µ$ from token counts and prices (§6.10), via domain math. */
export function estimateReservationMicroUsd(
  inputEst: bigint,
  inputPricePerMtok: bigint,
  maxOutput: bigint,
  outputPricePerMtok: bigint,
): MicroUsd {
  return costMicroUsd(inputEst, inputPricePerMtok) + costMicroUsd(maxOutput, outputPricePerMtok);
}
