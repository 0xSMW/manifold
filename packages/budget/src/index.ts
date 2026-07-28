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
import { setWorkspaceGuc, type Sql, type TransactionSql } from "@manifold/database";
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

/** Epoch sentinel window_start. Used both by `total` (one row accumulates forever) and — for
 *  `rolling_30d` — as the per-account serialization ANCHOR row (finding 5): a fixed coordinate
 *  every rolling reserve locks regardless of which UTC-day row it bumps, so reserves that
 *  straddle a day boundary still serialize. It sits below every trailing-window lower bound, so
 *  it is never summed into a rolling guard. */
const EPOCH = new Date(0);

/** Default reservation TTL. Real callers pass `expires_at ≥ route.overall_ms` so a
 *  reservation never expires mid-stream (§8.4); one hour is the safe default here. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Max forward clock-skew tolerated between a `requestId` ULID's embedded timestamp and
 *  wall-clock "now" (hardening for bug #4). `window_start` is derived from that timestamp
 *  (§6.7), so `requestId` MUST be server-minted by the gateway at dispatch time (its
 *  timestamp ≈ now) — never caller-chosen. A ULID minted arbitrarily far in the FUTURE would
 *  resolve `bucketStart` into a not-yet-open window with a full, virgin headroom, letting a
 *  request spend NOW against a period that hasn't started yet and bypass an exhausted current
 *  bucket — a durable-overspend vector once that future window becomes "now". Past timestamps
 *  are legitimate (retries across a partition boundary, `rolling_30d` backfill, §16.3) so only
 *  the future direction is clamped; this is a fail-closed assertion, not a money-math change.
 *
 *  24h, not a tight clock-skew bound: same-UTC-day request/response latency and any reasonable
 *  gateway/DB clock drift stay well inside it, so it never rejects a genuine server-minted
 *  requestId. It still closes the durable multi-day/week/month bucket-skip this bug describes
 *  (forging next month's/next year's window while the CURRENT one is exhausted); it does not
 *  (and structurally cannot, without also rejecting legitimate same-day traffic) block forging
 *  the NEXT calendar day's daily bucket a few hours early — that residual slice is why §16.3
 *  requires `requestId` to be minted ONLY by the trusted gateway, never accepted from a
 *  caller-supplied value. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

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

/** One budget_account in a leaf→root chain (§16.3 M13 hierarchical budgets). */
interface ChainAccount {
  id: string;
  parent_id: string | null;
  limit_amount: string;
  /** Window policy (`daily`/`weekly`/`monthly`/`rolling_30d`/`total`), drives bucketStart. */
  window: string;
  /** `cost_microusd` or `tokens` — selects which counter columns the guard/bump use. */
  unit: string;
  workspace_id: string;
  /** A quarantine/administrative disable is an admission deny for this entire chain. */
  disabled_at: Date | null;
}

interface ReservationRow {
  id: string;
  workspace_id: string;
  budget_account_id: string;
  request_id: string;
  reserved_microusd: string;
  /** Held token estimate for token-unit budgets; null on legacy rows (treated as 0). */
  reserved_tokens: string | null;
  status: BudgetReservationState;
  reconciled_microusd: string | null;
  created_at: Date;
  /** The EXACT counter-row coordinates reserve() bumped (§16.3), persisted on the row so
   *  commit/rollback/sweep decrement THAT row instead of re-deriving (bucketStart, shard=0).
   *  These are the LEAF coordinates; ancestor rows are re-derived from each ancestor's window. */
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
    shard = DEFAULT_SHARD,
  } = input;

  const createdAt = ulidCreatedAt(requestId);
  // Bug #4 hardening: fail closed on a requestId whose embedded ULID timestamp is further in
  // the future than a generous clock-skew tolerance — see MAX_FUTURE_SKEW_MS above. A
  // server-minted requestId is always ≈ now; only a chosen/forged one lands far ahead.
  if (createdAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: BUDGET_RESERVE_DENIED };
  }
  const expiresAt = input.expiresAt ?? new Date(createdAt.getTime() + DEFAULT_TTL_MS);
  // Non-negativity (bug #2; mirrors commit's actual clamp, §8.4): a negative est/estTokens
  // would flow straight into the step-8 bump as `reserved_(microusd|tokens) + est`, i.e. a
  // DECREMENT — freeing phantom headroom for a request that reserved nothing. Clamp every
  // estimate to >= 0 before it ever reaches the guard (step 6) or the bump (step 8).
  const rawEst = BigInt(estMicroUsd);
  const est = rawEst < 0n ? 0n : rawEst;
  const rawInputTokens = input.estimatedInputTokens ?? 0n;
  const rawOutputTokens = input.maxOutputTokens ?? 0n;
  const estimatedInputTokens = rawInputTokens < 0n ? 0n : rawInputTokens;
  const maxOutputTokens = rawOutputTokens < 0n ? 0n : rawOutputTokens;
  // Token-unit budgets reserve on TOKEN counts (est_input + max_output), not µ$.
  const estTokens = estimatedInputTokens + maxOutputTokens;

  return db.begin(async (sql: TransactionSql): Promise<ReserveResult> => {
    // Tenant scope for RLS (§6.16); harmless (and correct) whether or not the caller
    // connects as an RLS-exempt role. Set BEFORE any budget_account/budget_window_state read.
    await setWorkspaceGuc(sql, workspaceId);

    // 1. Load the budget chain leaf→root (§16.3 M13). Non-hierarchical budgets → length 1.
    //    A reserve must fit EVERY ancestor's cap, not just the leaf's.
    const chain = await loadChain(sql, budgetAccountId);
    if (chain.length === 0) return { ok: false, reason: BUDGET_RESERVE_DENIED };
    // Quarantine is enforced at the authoritative reserve transaction, including every parent
    // cap. Existing reservations still reconcile through commit(), which deliberately does not
    // apply this admission-only check.
    if (chain.some((account) => account.disabled_at !== null)) {
      return { ok: false, reason: BUDGET_RESERVE_DENIED };
    }
    const leaf = chain[0]!;

    // 2. Counter coordinates per account. window_start is DERIVED from each account's own window
    //    policy + the request's created_at — NEVER the caller-supplied windowStart, which a caller
    //    could vary per request to open a virgin counter and bypass the real bucket. Only the leaf
    //    carries the request's shard; ancestors accumulate on shard 0.
    const coords = chain.map((acct) => ({
      acct,
      windowStart: bucketStart(acct.window, createdAt),
      shard: acct.id === leaf.id ? shard : DEFAULT_SHARD,
    }));

    // 2b. Per-account SERIALIZATION ANCHOR — the single row every concurrent reserve for the
    //     same logical window MUST lock, closing two oversell races the per-shard/per-day locks
    //     alone miss:
    //       Finding 4 (fresh-shard oversell): on a brand-new window, two reserves targeting
    //         DISTINCT new shard rows would upsert+lock disjoint sets and, under READ COMMITTED,
    //         each sum only its own uncommitted row and both admit the full limit. Anchoring on
    //         shard 0 at the request's window_start forces them to serialize on ONE row.
    //       Finding 5 (rolling_30d day-straddle oversell): the guard sums the trailing 30 daily
    //         rows but the per-day lock covers only today's row, so two reserves either side of a
    //         UTC-day boundary lock DIFFERENT day rows and both admit. A fixed epoch-sentinel
    //         anchor (below every trailing lower bound, so never summed) serializes every rolling
    //         reserve on the account.
    //     For fixed windows the anchor coincides with the shard-0 row at the request window, so
    //     no extra row is created; for rolling_30d it is the epoch anchor row.
    const anchors = chain.map((acct) => ({
      acct,
      windowStart: acct.window === "rolling_30d" ? EPOCH : bucketStart(acct.window, createdAt),
      shard: DEFAULT_SHARD,
    }));

    // 3. Upsert every counter row FIRST (bump rows + anchors, deduped) so a just-opened window
    //    can't race two first-requests into an oversell (M14). ON CONFLICT DO NOTHING — never
    //    clobbers. Anchor rows guarantee the serialization row exists to be locked in step 4.
    const upsertRows = new Map<string, { acctId: string; windowStart: Date; shard: number }>();
    for (const c of [...coords, ...anchors]) {
      upsertRows.set(`${c.acct.id}|${c.windowStart.getTime()}|${c.shard}`, {
        acctId: c.acct.id,
        windowStart: c.windowStart,
        shard: c.shard,
      });
    }
    for (const r of upsertRows.values()) {
      await sql`
        INSERT INTO budget_window_state (workspace_id, budget_account_id, window_start, shard)
        VALUES (${workspaceId}, ${r.acctId}, ${r.windowStart}, ${r.shard})
        ON CONFLICT DO NOTHING
      `;
    }

    // 4. Lock the whole working set under ONE global order: accounts by id ASC (M13,
    //    deadlock-free — ULIDs are time-ordered not depth-ordered, so id order, not traversal
    //    order). Within an account: the ANCHOR row first (the serialization point), then ALL
    //    sibling shard rows at the request window by shard ASC. Locking every SIBLING shard (not
    //    just the request's) is what makes the cross-shard headroom guard oversell-proof:
    //    concurrent reserves on different shards serialize here instead of each admitting the
    //    full limit against its own row. `releaseReservation` locks the SAME rows in this SAME
    //    account-id-ASC order (finding 2), so reserve/commit/rollback/sweep never deadlock.
    const accountsAsc = [...chain].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const acct of accountsAsc) {
      const anchor = anchors.find((a) => a.acct.id === acct.id)!;
      const coord = coords.find((c) => c.acct.id === acct.id)!;
      await sql`
        SELECT 1 FROM budget_window_state
        WHERE budget_account_id = ${acct.id}
          AND window_start = ${anchor.windowStart} AND shard = ${anchor.shard}
        FOR UPDATE
      `;
      await sql`
        SELECT shard FROM budget_window_state
        WHERE budget_account_id = ${acct.id} AND window_start = ${coord.windowStart}
        ORDER BY shard
        FOR UPDATE
      `;
    }

    // 5. Idempotent replay: serialized behind the leaf row lock. A reservation for
    //    (budget, request, created_at) that ALREADY exists returns unchanged ONLY while it is
    //    still `reserved`. A TERMINAL replay (committed/rolled_back/expired) must NOT grant a
    //    fresh hold — otherwise a retried requestId after commit returns ok and the caller
    //    dispatches again for free. Deny it instead (§8.4).
    const existingRows = await sql<ReservationRow[]>`
      SELECT id, workspace_id, budget_account_id, reserved_microusd, reserved_tokens,
             status, created_at, window_start, shard
      FROM budget_reservation
      WHERE budget_account_id = ${leaf.id}
        AND request_id = ${requestId}
        AND created_at = ${createdAt}
    `;
    const existing = existingRows[0];
    if (existing) {
      if (existing.status !== "reserved") {
        return { ok: false, reason: BUDGET_RESERVE_DENIED };
      }
      return {
        ok: true,
        reservationId: existing.id,
        reservedMicroUsd: BigInt(existing.reserved_microusd),
        idempotentReplay: true,
      };
    }

    // 6. Guard EVERY account in the chain. Headroom is Σ over ALL shards (and, for rolling_30d,
    //    over the trailing 30 daily rows) of committed+reserved vs that account's own limit —
    //    cost-unit on µ$, token-unit on tokens (§6.7 window semantics).
    for (const c of coords) {
      const add = c.acct.unit === "tokens" ? estTokens : est;
      const used = await usedForAccount(sql, c.acct, c.windowStart);
      if (used + add > BigInt(c.acct.limit_amount)) {
        return { ok: false, reason: BUDGET_RESERVE_DENIED };
      }
    }

    // 7. Create the reservation, stamped with the LEAF coordinates (release re-derives ancestors).
    const reservationId = ulid(createdAt.getTime());
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO budget_reservation (
        id, workspace_id, budget_account_id, request_id,
        estimated_input_tokens, max_output_tokens,
        reserved_microusd, reserved_tokens, status, expires_at, created_at,
        window_start, shard
      ) VALUES (
        ${reservationId}, ${workspaceId}, ${leaf.id}, ${requestId},
        ${p(estimatedInputTokens)}, ${p(maxOutputTokens)},
        ${p(est)}, ${p(estTokens)}, 'reserved', ${expiresAt}, ${createdAt},
        ${coords[0]!.windowStart}, ${coords[0]!.shard}
      )
      ON CONFLICT (budget_account_id, request_id, created_at) DO NOTHING
      RETURNING id
    `;
    if (!inserted[0]) {
      // Lost an insert race for the same request under a concurrent tenant-exempt path:
      // re-read and return the winner without bumping (still no double-count).
      const raced = await sql<ReservationRow[]>`
        SELECT id, reserved_microusd, status FROM budget_reservation
        WHERE budget_account_id = ${leaf.id}
          AND request_id = ${requestId}
          AND created_at = ${createdAt}
      `;
      const w = raced[0]!;
      if (w.status !== "reserved") return { ok: false, reason: BUDGET_RESERVE_DENIED };
      return {
        ok: true,
        reservationId: w.id,
        reservedMicroUsd: BigInt(w.reserved_microusd),
        idempotentReplay: true,
      };
    }

    // 8. Bump reserved on EVERY account's counter row (leaf + ancestors), unit-appropriately —
    //    ONLY for a genuinely new reservation.
    for (const c of coords) {
      if (c.acct.unit === "tokens") {
        await sql`
          UPDATE budget_window_state
          SET reserved_tokens = reserved_tokens + ${p(estTokens)}, updated_at = now()
          WHERE budget_account_id = ${c.acct.id}
            AND window_start = ${c.windowStart}
            AND shard = ${c.shard}
        `;
      } else {
        await sql`
          UPDATE budget_window_state
          SET reserved_microusd = reserved_microusd + ${p(est)}, updated_at = now()
          WHERE budget_account_id = ${c.acct.id}
            AND window_start = ${c.windowStart}
            AND shard = ${c.shard}
        `;
      }
    }

    return { ok: true, reservationId, reservedMicroUsd: est, idempotentReplay: false };
  });
}

export interface CommitResult {
  ok: boolean;
  status: BudgetReservationState;
  committedMicroUsd: MicroUsd;
  /** The durable request binding recovered under the reservation row lock. */
  requestId?: string;
  /** Bug #1: true when this commit's `actual` (cost or tokens) exceeded the amount that was
   *  actually held (`reserved_(microusd|tokens)` at reserve time) — i.e. this commit just
   *  durably booked committed spend PAST what reserve() ever guarded against, including the
   *  late expired→committed reconcile path (H1). The commit itself is still "money truth": the
   *  actual is always booked in full (never clamped to the held estimate or the account limit,
   *  §8.4) and `reserved` never releases more than it held — this flag exists so a caller CAN
   *  detect/alert/audit the overspend instead of it passing silently. `false` for a no-op /
   *  missing / blocked outcome (nothing was released, so there is nothing to compare). */
  overspent: boolean;
}

/** Facts available under the commit transaction's reservation lock for a durable side effect. */
export interface BudgetCommitEvidence {
  reservationId: string;
  workspaceId: string;
  requestId: string;
  heldMicroUsd: bigint;
  actualMicroUsd: bigint;
  actualTokens: bigint;
  overspent: boolean;
}

export interface CommitOptions {
  /** Bind a terminal reconciliation to the gateway trace that created its reservation. */
  expectedRequestId?: string;
  /** Runs in the same transaction after the reservation has been reconciled. */
  afterCommit?: (sql: TransactionSql, evidence: BudgetCommitEvidence) => Promise<void>;
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
  actualTokens?: bigint,
  options: CommitOptions = {},
): Promise<CommitResult> {
  // Non-negativity (§8.4): a negative actual would DECREMENT committed and free phantom
  // headroom (a caller could reconcile at −$X to un-charge real spend). Clamp to 0.
  const rawActual = BigInt(actualMicroUsd);
  const actual = rawActual < 0n ? 0n : rawActual;
  const rawTokens = actualTokens ?? 0n;
  const actualToks = rawTokens < 0n ? 0n : rawTokens;
  return db.begin(async (sql: TransactionSql): Promise<CommitResult> => {
    const out = await releaseReservation(sql, reservationId, "COMMIT", {
      actual,
      actualTokens: actualToks,
      workspaceId,
      expectedRequestId: options.expectedRequestId,
    });
    switch (out.kind) {
      case "released":
        // Bug #1: the actual is booked in FULL regardless of what was held (money truth, §8.4;
        // this never clamps `actual` and never releases more than `out.heldMicroUsd` from
        // `reserved` — see releaseReservation). `overspent` surfaces the durable over-limit
        // commit for the caller to detect/alert/audit instead of it passing silently.
        {
          const overspent = actual > out.heldMicroUsd || actualToks > out.heldTokens;
          if (options.afterCommit) {
            await options.afterCommit(sql, {
              reservationId,
              workspaceId: out.workspaceId,
              requestId: out.requestId,
              heldMicroUsd: out.heldMicroUsd,
              actualMicroUsd: actual,
              actualTokens: actualToks,
              overspent,
            });
          }
          return {
          ok: true,
          status: out.status,
          committedMicroUsd: actual,
          requestId: out.requestId,
          overspent,
          };
        }
      case "missing":
        return { ok: false, status: "expired", committedMicroUsd: 0n, overspent: false };
      case "noop":
        // Already terminal — no-op (idempotent reconcile); echoes the requested actual.
        return {
          ok: false,
          status: out.status,
          committedMicroUsd: out.status === "committed" ? out.reconciledMicroUsd : actual,
          requestId: out.requestId,
          overspent: out.status === "committed" && out.reconciledMicroUsd > out.heldMicroUsd,
        };
      case "blocked":
        return { ok: false, status: out.status, committedMicroUsd: 0n, overspent: false };
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
 * held `reserved`. This is the "no terminal Observation ever produced" release path. If a
 * terminal cost arrives LATER for a swept reservation, `commit()` reconciles it expired →
 * committed so the real spend is still counted, never zeroed (H1). Returns the count of
 * reservations expired.
 *
 * FINDING 3 — this ALL-WORKSPACES sweep runs its discovery SELECT with NO `manifold.workspace_id`
 * GUC, so it MUST be invoked by a maintenance role that is EXEMPT from RLS (a BYPASSRLS or table-
 * owner role — the cron/reconciler-worker connection, NOT the RLS-subject `manifold_app` gateway
 * role). Under FORCE-RLS as an RLS-subject role the unscoped discovery SELECT matches ZERO rows
 * (RLS filters every workspace out because the tenant GUC is unset) and the sweep silently no-ops,
 * permanently stranding expired holds — the per-row set_config inside the release loop is far too
 * late to save the discovery read. Callers pinned to an RLS-subject role must instead iterate
 * `sweepExpiredForWorkspace` per workspace. (Cron/worker wiring is app-level, out of this package.)
 */
export async function sweepExpired(db: Sql, now: Date = new Date()): Promise<number> {
  // Find expired holds first (short read; requires an RLS-exempt role — see doc above), then
  // release each under its window lock. Carry each row's workspace_id so the release sets the
  // tenant GUC BEFORE locking the row (bug #5).
  const expired = await db<{ id: string; created_at: Date; workspace_id: string }[]>`
    SELECT id, created_at, workspace_id FROM budget_reservation
    WHERE status = 'reserved' AND expires_at < ${now}
  `;
  return releaseExpiredRows(db, expired);
}

/**
 * FINDING 3 — the RLS-SUBJECT-SAFE sweep entrypoint. Sweeps expired reservations for ONE
 * workspace, setting `manifold.workspace_id` in the SAME transaction as the discovery SELECT so
 * the read is visible under FORCE-RLS as `manifold_app` (the unscoped `sweepExpired` above matches
 * zero rows for such a role). An RLS-subject worker sweeps the whole fleet by iterating this over
 * every workspace id it owns. Returns the count expired for this workspace.
 */
export async function sweepExpiredForWorkspace(
  db: Sql,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  // GUC via set_config(..., true) is transaction-local, so the discovery SELECT must share the
  // transaction that sets it — hence the db.begin wrapper around the read.
  const expired = await db.begin(async (sql: TransactionSql) => {
    await setWorkspaceGuc(sql, workspaceId);
    return sql<{ id: string; created_at: Date; workspace_id: string }[]>`
      SELECT id, created_at, workspace_id FROM budget_reservation
      WHERE workspace_id = ${workspaceId} AND status = 'reserved' AND expires_at < ${now}
    `;
  });
  return releaseExpiredRows(db, expired);
}

/** Release each discovered expired reservation in its own transaction (each sets the tenant GUC
 *  from the row's workspace_id before locking — bug #5). Shared by both sweep entrypoints. */
async function releaseExpiredRows(
  db: Sql,
  expired: { id: string; created_at: Date; workspace_id: string }[],
): Promise<number> {
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
  | {
      kind: "released";
      status: BudgetReservationState;
      workspaceId: string;
      requestId: string;
      /** The reservation's ORIGINAL held estimate (§8.4) — persisted on `budget_reservation` at
       *  reserve time and never mutated by release, so it is available here in BOTH the normal
       *  release path and the late expired→committed path (bug #1). Callers diff this against
       *  the actual to detect an overspend. */
      heldMicroUsd: bigint;
      heldTokens: bigint;
    }
  | { kind: "missing"; status: "expired" }
  | { kind: "noop"; status: BudgetReservationState; requestId: string; heldMicroUsd: bigint; reconciledMicroUsd: bigint }
  | { kind: "blocked"; status: BudgetReservationState };

/**
 * The shared release skeleton behind commit / rollback / sweepExpired (§8.4). Under the
 * reservation's row lock it: scopes the tenant GUC, walks the budget chain leaf→root, and for
 * EVERY account in the chain subtracts the held estimate from `reserved` and (commit only) adds
 * the actual to `committed` — cost-unit on µ$, token-unit on tokens. The leaf uses the persisted
 * (window_start, shard); ancestors re-derive their coordinates from each ancestor's window.
 *
 * `COMMIT` (the product verb; formerly `RECONCILE`) also handles the LATE-TERMINAL case (H1):
 * if the reservation was already
 * swept to `expired` (its hold released), a terminal actual arriving afterward is still counted
 * into `committed` (expired → committed), so real spend that outlived the reservation window is
 * never zeroed. Any other terminal state is an idempotent no-op. MUST run inside a `db.begin`
 * transaction — the caller owns BEGIN/COMMIT.
 */
async function releaseReservation(
  sql: TransactionSql,
  reservationId: string,
  event: "COMMIT" | "ROLLBACK" | "EXPIRE",
  opts: { actual?: bigint; actualTokens?: bigint; workspaceId?: string; expectedRequestId?: string } = {},
): Promise<ReleaseOutcome> {
  // Scope the tenant GUC FIRST — BEFORE the lock — so the reservation row is visible to the
  // FOR UPDATE lock under RLS (bug #5). Without this, an RLS-subject role locks 0 rows and
  // the release silently no-ops, permanently stranding the held `reserved`. Mirrors reserve(),
  // which also sets the GUC before touching any RLS-protected row. RLS-exempt callers may
  // omit it (the lock sees the row regardless); we then fall back to the row's own workspace.
  if (opts.workspaceId !== undefined) {
    await setWorkspaceGuc(sql, opts.workspaceId);
  }
  const res = await lockReservation(sql, reservationId);
  if (!res) return { kind: "missing", status: "expired" };
  await setWorkspaceGuc(sql, res.workspace_id);
  if (opts.expectedRequestId !== undefined && res.request_id !== opts.expectedRequestId) {
    return { kind: "blocked", status: res.status };
  }

  const actual = opts.actual ?? 0n;
  const actualTokens = opts.actualTokens ?? 0n;
  const chain = await loadChain(sql, res.budget_account_id);

  // Finding 2 (ABBA deadlock): acquire the chain's counter-row locks in the SAME global order
  // reserve() uses — budget_account id ASC — via an explicit ordered SELECT ... FOR UPDATE BEFORE
  // any UPDATE below. release previously UPDATEd the chain leaf→root (depth order), the OPPOSITE
  // of reserve's id-ASC lock order, so a commit/rollback/sweep racing a reserve on the same
  // hierarchical budget could deadlock (each holding one row, waiting on the other). Ordering the
  // locks here removes the cycle. We lock the EXACT rows the UPDATEs will touch: the leaf uses the
  // persisted (window_start, shard); ancestors re-derive their shard-0 coordinate. This covers
  // both the normal release and the late-terminal (expired → committed) branch below.
  const releaseLockOrder = chain
    .map((acct) => ({ acct, coord: releaseCoord(acct, res) }))
    .sort((a, b) => (a.acct.id < b.acct.id ? -1 : a.acct.id > b.acct.id ? 1 : 0));
  for (const { acct, coord } of releaseLockOrder) {
    await sql`
      SELECT 1 FROM budget_window_state
      WHERE budget_account_id = ${acct.id}
        AND window_start = ${coord.windowStart} AND shard = ${coord.shard}
      FOR UPDATE
    `;
  }

  if (res.status !== "reserved") {
    // Late-terminal reconcile (H1 / §8.4): the sweep already expired this hold (reserved → 0),
    // but a terminal cost arrived afterward. Count that real spend into committed and move
    // expired → committed WITHOUT touching reserved again. Any other terminal state is a no-op.
    if (event === "COMMIT" && res.status === "expired") {
      for (const acct of chain) {
        const coord = releaseCoord(acct, res);
        if (acct.unit === "tokens") {
          await sql`
            UPDATE budget_window_state
            SET committed_tokens = committed_tokens + ${p(actualTokens)}, updated_at = now()
            WHERE budget_account_id = ${acct.id}
              AND window_start = ${coord.windowStart} AND shard = ${coord.shard}
          `;
        } else {
          await sql`
            UPDATE budget_window_state
            SET committed_microusd = committed_microusd + ${p(actual)}, updated_at = now()
            WHERE budget_account_id = ${acct.id}
              AND window_start = ${coord.windowStart} AND shard = ${coord.shard}
          `;
        }
      }
      await sql`
        UPDATE budget_reservation
        SET status = 'committed',
            reconciled_microusd = ${p(actual)},
            reconciled_at = now()
        WHERE id = ${reservationId} AND created_at = ${res.created_at}
      `;
      return {
        kind: "released",
        status: "committed",
        workspaceId: res.workspace_id,
        requestId: res.request_id,
        heldMicroUsd: BigInt(res.reserved_microusd),
        heldTokens: BigInt(res.reserved_tokens ?? "0"),
      };
    }
    return {
      kind: "noop",
      status: res.status,
      requestId: res.request_id,
      heldMicroUsd: BigInt(res.reserved_microusd),
      reconciledMicroUsd: BigInt(res.reconciled_microusd ?? "0"),
    };
  }

  // Domain state machine is the source of truth for the legal transition. (`event` is a
  // union of literal tags; re-narrow it to the discriminated event the machine expects.)
  const next = transitionBudgetReservation(
    "reserved",
    { type: event } as Parameters<typeof transitionBudgetReservation>[1],
  );
  if (!next.ok) return { kind: "blocked", status: res.status };

  // Release the held estimate from EVERY account in the chain (leaf + ancestors), and — for
  // commit — add the actual to committed. Release-only paths leave committed unchanged (add 0).
  const heldMicroUsd = BigInt(res.reserved_microusd);
  const heldTokens = BigInt(res.reserved_tokens ?? "0");
  for (const acct of chain) {
    const coord = releaseCoord(acct, res);
    if (acct.unit === "tokens") {
      await sql`
        UPDATE budget_window_state
        SET reserved_tokens = reserved_tokens - ${p(heldTokens)},
            committed_tokens = committed_tokens + ${p(actualTokens)},
            updated_at = now()
        WHERE budget_account_id = ${acct.id}
          AND window_start = ${coord.windowStart} AND shard = ${coord.shard}
      `;
    } else {
      await sql`
        UPDATE budget_window_state
        SET reserved_microusd = reserved_microusd - ${p(heldMicroUsd)},
            committed_microusd = committed_microusd + ${p(actual)},
            updated_at = now()
        WHERE budget_account_id = ${acct.id}
          AND window_start = ${coord.windowStart} AND shard = ${coord.shard}
      `;
    }
  }
  // Only commit stamps reconciled_microusd; rollback/sweep leave it as-is (COALESCE keeps
  // the existing value when `actual` was not supplied).
  const reconciled = opts.actual !== undefined ? p(actual) : null;
  await sql`
    UPDATE budget_reservation
    SET status = ${next.state},
        reconciled_microusd = COALESCE(${reconciled}, reconciled_microusd),
        reconciled_at = now()
    WHERE id = ${reservationId} AND created_at = ${res.created_at}
  `;
  return {
    kind: "released",
    status: next.state,
    workspaceId: res.workspace_id,
    requestId: res.request_id,
    heldMicroUsd,
    heldTokens,
  };
}

/**
 * The counter-row coordinates to release for one account in a reservation's chain. The LEAF
 * (the reservation's own budget_account) uses the persisted (window_start, shard) reserve()
 * stamped; ancestors re-derive window_start from their own window policy at the request's
 * created_at and accumulate on shard 0 (§16.3).
 */
function releaseCoord(
  acct: ChainAccount,
  res: ReservationRow,
): { windowStart: Date; shard: number } {
  if (acct.id === res.budget_account_id) {
    return { windowStart: res.window_start, shard: res.shard };
  }
  return { windowStart: bucketStart(acct.window, res.created_at), shard: DEFAULT_SHARD };
}

/**
 * Load a budget_account and its ancestor chain leaf→root via `parent_id` (§16.3 M13). Returns
 * the leaf first. Reads budget_account under RLS, so the tenant GUC must already be set by
 * the caller.
 *
 * Bug #3 hardening — two invariants the plain depth-bound alone did not enforce:
 *   - CYCLE GUARD: `depth < 32` alone does not stop a cycle (e.g. a self-parent, or A<->B),
 *     it only bounds it — a self-parent (`parent_id = id`) re-joined itself on every step and
 *     produced 33 DUPLICATE rows for the same account. Every downstream consumer (the guard AND
 *     the reserved/committed bump) iterates the returned array once per row, so that account's
 *     counter row got bumped 33x for a single reservation. A `visited` id array, checked before
 *     each recursive step, stops the walk the moment a parent would revisit an id already in the
 *     chain, so a self/mutual-cycle chain always resolves to exactly the acyclic prefix (length 1
 *     for a direct self-parent).
 *   - SAME-WORKSPACE PARENT: a parent in a different workspace is invisible under RLS (the GUC
 *     scopes every budget_account read to one workspace_id), so it silently drops out of the
 *     recursion with no error — correct under RLS, but SILENT and unenforced for any RLS-exempt
 *     caller (superuser/migration paths, or a future service role). Make the invariant explicit
 *     in the query itself: a parent only joins the chain when its workspace_id matches its
 *     child's, so a cross-workspace `parent_id` is deterministically excluded (never partially
 *     applied) instead of relying solely on RLS to hide it.
 */
async function loadChain(sql: TransactionSql, leafId: string): Promise<ChainAccount[]> {
  return sql<ChainAccount[]>`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, limit_amount, "window", unit, workspace_id, disabled_at, 0 AS depth,
             ARRAY[id] AS visited
      FROM budget_account WHERE id = ${leafId}
      UNION ALL
      SELECT p.id, p.parent_id, p.limit_amount, p."window", p.unit, p.workspace_id, p.disabled_at, c.depth + 1,
             c.visited || p.id
      FROM budget_account p JOIN chain c ON p.id = c.parent_id
      WHERE c.depth < 32
        AND NOT (p.id = ANY(c.visited))
        AND p.workspace_id = c.workspace_id
    )
    SELECT id, parent_id, limit_amount, "window", unit, workspace_id, disabled_at FROM chain ORDER BY depth
  `;
}

/**
 * Headroom-used for one account's window (§6.7 window semantics): Σ over ALL shards of
 * committed+reserved at `windowStart`, or — for `rolling_30d` — Σ over the trailing 30 daily
 * rows `[windowStart − 29d, windowStart]`. Returns tokens for a token-unit budget, else µ$.
 */
async function usedForAccount(
  sql: TransactionSql,
  acct: ChainAccount,
  windowStart: Date,
): Promise<bigint> {
  let rows: { m: string; t: string }[];
  if (acct.window === "rolling_30d") {
    const lower = new Date(windowStart.getTime() - 29 * 24 * 60 * 60 * 1000);
    rows = await sql<{ m: string; t: string }[]>`
      SELECT COALESCE(SUM(committed_microusd + reserved_microusd), 0)::text AS m,
             COALESCE(SUM(committed_tokens + reserved_tokens), 0)::text AS t
      FROM budget_window_state
      WHERE budget_account_id = ${acct.id}
        AND window_start >= ${lower} AND window_start <= ${windowStart}
    `;
  } else {
    rows = await sql<{ m: string; t: string }[]>`
      SELECT COALESCE(SUM(committed_microusd + reserved_microusd), 0)::text AS m,
             COALESCE(SUM(committed_tokens + reserved_tokens), 0)::text AS t
      FROM budget_window_state
      WHERE budget_account_id = ${acct.id} AND window_start = ${windowStart}
    `;
  }
  const r = rows[0]!;
  return acct.unit === "tokens" ? BigInt(r.t) : BigInt(r.m);
}

/**
 * Lock a reservation row FOR UPDATE by id (ULID → practically unique across partitions).
 * Reads the persisted (window_start, shard) so commit/rollback/sweep decrement the EXACT
 * leaf counter row reserve() bumped (§16.3); ancestors are re-derived from the chain.
 */
async function lockReservation(sql: TransactionSql, reservationId: string): Promise<ReservationRow | undefined> {
  const rows = await sql<ReservationRow[]>`
    SELECT id, workspace_id, budget_account_id, request_id, reserved_microusd, reserved_tokens,
           status, reconciled_microusd, created_at, window_start, shard
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
