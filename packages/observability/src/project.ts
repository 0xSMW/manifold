// packages/observability/src/project.ts — Observation → usage_record + cost_ledger rows.
//
// SPEC §6.9 (usage_record, cost_ledger), §8.3 (project → usage_record, cost_ledger), §6.10
// (cost = Σ round_half_even per token class). `project` is a PURE, deterministic function of
// the Observation; cost is computed via @manifold/domain `computeCost` from the reduced
// tokens + resolved price, so a no-byte trace (zero tokens) projects a ZERO-cost ledger row.
import { computeCost, type MicroUsd, type TokenCounts } from "@manifold/domain";
import type { CostFidelity } from "./events.js";
import type { Observation } from "./observation.js";

/** A `usage_record` row (SPEC §6.9) — token truth, fidelity kept separate. */
export interface UsageRecord {
  workspaceId: string;
  traceId: string;
  tokens: TokenCounts;
  fidelity: CostFidelity;
  occurredAt: string | null;
}

/** A `cost_ledger` row (SPEC §6.9) — money truth; survives compaction. */
export interface CostLedgerRow {
  workspaceId: string;
  traceId: string;
  amountMicroUsd: MicroUsd;
  fidelity: CostFidelity;
  priceRevisionId: string | null;
  offeringId: string | null;
  budgetAccountId: string | null;
  costCenterId: string | null;
  teamId: string | null;
  appId: string | null;
  virtualKeyId: string | null;
  occurredAt: string | null;
}

/**
 * Project a reduced Observation into its `usage_record` + `cost_ledger` rows (SPEC §8.3, §6.9).
 * Pure and deterministic: cost is `computeCost(obs.tokens, obs.price)` (SPEC §6.10, integer µ$).
 */
export function project(obs: Observation): { usage: UsageRecord; cost: CostLedgerRow } {
  const usage: UsageRecord = {
    workspaceId: obs.workspaceId,
    traceId: obs.traceId,
    tokens: obs.tokens,
    fidelity: obs.costFidelity,
    occurredAt: obs.occurredAt,
  };

  const cost: CostLedgerRow = {
    workspaceId: obs.workspaceId,
    traceId: obs.traceId,
    amountMicroUsd: computeCost(obs.tokens, obs.price),
    fidelity: obs.costFidelity,
    priceRevisionId: obs.priceRevisionId,
    offeringId: obs.finalOfferingId,
    budgetAccountId: obs.budgetAccountId,
    costCenterId: obs.costCenterId,
    teamId: obs.teamId,
    appId: obs.appId,
    virtualKeyId: obs.virtualKeyId,
    occurredAt: obs.occurredAt,
  };

  return { usage, cost };
}
