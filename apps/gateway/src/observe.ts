// apps/gateway/src/observe.ts — the in-process ingest → reduce → project → persist path (§8.3).
//
// This is the ADAPTER seam that closes the observation/billing loop the gateway core opened. The core
// emits FLAT `@manifold/ports` events into an IngestSink; here we (1) map them to journal events via
// @manifold/observability's #113 mapper, (2) `reduce()` the trace to a deterministic Observation,
// (3) `project()` it to usage_record + cost_ledger rows, (4) INSERT those into Postgres, and (5)
// reconcile the hard-budget reservation reserved→committed with the ACTUAL cost via @manifold/budget.
//
// The DB driver touch lives HERE (an adapter), never in gateway-core or observability (§4.2): those
// stay pure. The ingest TRANSPORT is in-process (call this directly with the collected events); the
// DB writes and the §6.10 cost math are REAL. A durable queue/worker is the production transport, but
// it reduces/projects with this exact code.
import type { Sql } from "@manifold/database";
import type { ObservationEvent as PortsEvent } from "@manifold/ports";
import { ulid } from "@manifold/budget";
import { commit, type CommitResult } from "@manifold/budget";
import {
  journalFromPortsEvents,
  project,
  reduce,
  type CostLedgerRow,
  type Observation,
  type UsageRecord,
} from "@manifold/observability";

/** Bind a bigint as its decimal string so postgres-js keeps int8 columns exact (never a float). */
const p = (b: bigint): string => b.toString();

export interface IngestTraceInput {
  sql: Sql;
  /** The flat events the gateway emitted for ONE trace. */
  events: readonly PortsEvent[];
  /** Tenant scope + producer id — the journal dedup anchor the flat events do not carry. */
  workspaceId: string;
  producerId: string;
}

export interface IngestTraceResult {
  observation: Observation;
  usage: UsageRecord;
  cost: CostLedgerRow;
  /** The reconcile outcome when the trace carried a hard-budget reservation; else undefined. */
  committed?: CommitResult;
}

/**
 * Ingest one trace's flat events: map → reduce → project → INSERT usage_record + cost_ledger, then
 * (if a reservation rode on the terminal) commit it to the ACTUAL projected cost. Returns the
 * projected rows + reconcile outcome so callers/tests can assert on them.
 */
export async function ingestTrace(input: IngestTraceInput): Promise<IngestTraceResult> {
  const { sql, events, workspaceId, producerId } = input;

  const journal = journalFromPortsEvents(events, { workspaceId, producerId });
  const observation = reduce(journal);
  const { usage, cost } = project(observation);

  // A single observation id ties the usage + cost rows to one another and back to the trace.
  const observationId = `obs_${observation.traceId}`;
  const occurredAt = observation.occurredAt ?? new Date().toISOString();

  await insertUsageRecord(sql, observationId, occurredAt, usage);
  await insertCostLedger(sql, observationId, occurredAt, cost);

  // BUDGET RECONCILE (§8.4): move the hold reserved→committed at the ACTUAL cost. The reservation id
  // rode on the flat terminal event (threaded from enforce.ts); the actual is exactly the µ$ we just
  // wrote to cost_ledger, so committed spend and recorded spend agree to the µ$.
  let committed: CommitResult | undefined;
  const terminal = events.find((e) => e.kind === "terminal" && e.reservationId);
  if (terminal?.reservationId) {
    committed = await commit(sql, terminal.reservationId, cost.amountMicroUsd, workspaceId);
  }

  return { observation, usage, cost, committed };
}

/** INSERT one `usage_record` row (SPEC §6.9). Token truth + fidelity; occurred_at is NOT NULL. */
async function insertUsageRecord(
  sql: Sql,
  observationId: string,
  occurredAt: string,
  u: UsageRecord,
): Promise<void> {
  const t = u.tokens;
  await sql`
    INSERT INTO usage_record (
      id, workspace_id, observation_id, trace_id,
      input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
      cache_write_tokens, audio_input_tokens, audio_output_tokens,
      fidelity, occurred_at
    ) VALUES (
      ${ulid()}, ${u.workspaceId}, ${observationId}, ${u.traceId},
      ${p(t.inputTokens)}, ${p(t.outputTokens)}, ${p(t.cacheReadTokens)}, ${p(t.reasoningTokens)},
      ${p(t.cacheWriteTokens)}, ${p(t.audioInputTokens)}, ${p(t.audioOutputTokens)},
      ${u.fidelity}, ${occurredAt}
    )
  `;
}

/** INSERT one `cost_ledger` row (SPEC §6.9). Money truth; amount_microusd is the §6.10 computeCost. */
async function insertCostLedger(
  sql: Sql,
  observationId: string,
  occurredAt: string,
  c: CostLedgerRow,
): Promise<void> {
  await sql`
    INSERT INTO cost_ledger (
      id, workspace_id, observation_id, trace_id,
      budget_account_id, cost_center_id, team_id, app_id, virtual_key_id,
      amount_microusd, fidelity, price_revision_id, offering_id, occurred_at
    ) VALUES (
      ${ulid()}, ${c.workspaceId}, ${observationId}, ${c.traceId},
      ${c.budgetAccountId}, ${c.costCenterId}, ${c.teamId}, ${c.appId}, ${c.virtualKeyId},
      ${p(c.amountMicroUsd)}, ${c.fidelity}, ${c.priceRevisionId}, ${c.offeringId}, ${occurredAt}
    )
  `;
}
