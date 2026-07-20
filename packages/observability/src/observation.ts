// packages/observability/src/observation.ts — the reduced Observation (SPEC §6.8, ADR-0011).
//
// The Observation is the deterministic reduction of one trace's events. It is a pure value:
// two reductions of the same event multiset are `deepEqual` regardless of delivery order or
// duplication (§16.6). It carries the token counts + resolved price so `project` can compute
// cost via @manifold/domain `computeCost` without any further input.
import type { ReasonCode } from "@manifold/contracts";
import type { PriceMicroUsd, TokenCounts } from "@manifold/domain";
import type { CostFidelity, ObservationStatus } from "./events.js";

/**
 * Reduced status. Extends the durable `observation.status` set (§6.8) with `incomplete`,
 * the in-memory representation of a trace whose terminal event has not (yet) arrived — a
 * missing terminal reduces to `incomplete`, never a crash (ADR-0011: journal is authority,
 * projection is derived and may lag).
 */
export type ReducedStatus = ObservationStatus | "incomplete";

/** The deterministic reduction of a trace's events (SPEC §6.8). */
export interface Observation {
  workspaceId: string;
  traceId: string;
  status: ReducedStatus;
  /** True iff a `terminal` event was present in the reduced set. */
  complete: boolean;
  httpStatus: number | null;
  /** Authoritative token counts (from the terminal event; zero when incomplete). */
  tokens: TokenCounts;
  /** Per-mtok µ$ prices resolved at dispatch — the cost input consumed by `project`. */
  price: PriceMicroUsd;
  costFidelity: CostFidelity;
  /** Number of `provider_attempt` events (post-dedup). */
  attempts: number;
  /** Attempts whose provider differs from the preceding attempt's (a failover, not a retry). */
  failovers: number;
  /** Sorted, de-duplicated union of every reason code seen (incl. INGEST_DEDUP on a dup). */
  reasonCodes: ReasonCode[];
  finalProvider: string | null;
  finalOfferingId: string | null;
  priceRevisionId: string | null;
  // Routing/cost dims projected onto usage_record / cost_ledger (SPEC §6.9).
  routeId: string | null;
  routeRevisionId: string | null;
  appId: string | null;
  teamId: string | null;
  costCenterId: string | null;
  virtualKeyId: string | null;
  budgetAccountId: string | null;
  /** Earliest `occurred_at` across the reduced events — deterministic, order-independent. */
  occurredAt: string | null;
}
