// apps/gateway/src/observe.ts — the in-process ingest → reduce → project → persist path (§8.3).
//
// This is the ADAPTER seam that closes the observation/billing loop the gateway core opened. The core
// emits FLAT `@manifold/ports` events into an IngestSink; here we (1) map them to journal events via
// @manifold/observability's #113 mapper, (2) `reduce()` the trace to a deterministic Observation,
// (3) `project()` it to observation + usage_record + cost_ledger rows, (4) INSERT those into
// Postgres, and (5)
// reconcile the hard-budget reservation reserved→committed with the ACTUAL cost via @manifold/budget.
//
// The DB driver touch lives HERE (an adapter), never in gateway-core or observability (§4.2): those
// stay pure. The ingest TRANSPORT is in-process (call this directly with the collected events); the
// DB writes and the §6.10 cost math are REAL. A durable queue/worker is the production transport, but
// it reduces/projects with this exact code.
import {
  recordProviderAttemptHealthFacts,
  setWorkspaceGuc,
  type ProviderAttemptHealthFactInput,
  type Sql,
  type TransactionSql,
} from "@manifold/database";
import type { HotPathObservationEvent } from "@manifold/ports";
import { commit, ulid, ulidCreatedAt, type BudgetCommitEvidence, type CommitResult } from "@manifold/budget";
import { createHash } from "node:crypto";
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
  events: readonly HotPathObservationEvent[];
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
 * A terminal observation has already been durably projected, but its reservation could not be
 * reconciled. Throwing this from the durable worker keeps the job retryable instead of allowing
 * the worker to mark money reconciliation complete.
 */
export class BudgetCommitInvariantError extends Error {
  readonly code = "BUDGET_COMMIT_INVARIANT";

  constructor(
    readonly details: {
      workspaceId: string;
      traceId: string;
      reservationId: string;
      status: CommitResult["status"];
    },
  ) {
    super(`budget commit invariant failed: ${details.status}`);
    this.name = "BudgetCommitInvariantError";
  }
}

/** A machine-readable operational event for a real spend that exceeded its admission hold. */
export interface BudgetOverspendOperationalSignal {
  type: "manifold.budget.overspent.v1";
  workspaceId: string;
  traceId: string;
  reservationId: string;
  actualMicroUsd: string;
  actualTokens: string;
}

export function budgetOverspendOperationalSignal(
  workspaceId: string,
  traceId: string,
  reservationId: string,
  actualMicroUsd: bigint,
  actualTokens: bigint,
): BudgetOverspendOperationalSignal {
  return {
    type: "manifold.budget.overspent.v1",
    workspaceId,
    traceId,
    reservationId,
    actualMicroUsd: actualMicroUsd.toString(),
    actualTokens: actualTokens.toString(),
  };
}

type BudgetAuditAction = "budget.overspent" | "budget.reconciliation_missing";

/** Persisted operational evidence; the audit-delivery trigger is the existing paging outbox. */
async function appendBudgetOperationalAudit(
  sql: TransactionSql,
  input: {
    workspaceId: string;
    action: BudgetAuditAction;
    targetKind: "budget_reservation" | "budget_account";
    targetId: string;
    requestRef: string;
    detail: Record<string, string>;
  },
): Promise<boolean> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 0))`;
  const existing = await sql<{ present: number }[]>`
    SELECT 1 AS present FROM audit_event
    WHERE workspace_id = ${input.workspaceId} AND action = ${input.action}
      AND target_kind = ${input.targetKind} AND target_id = ${input.targetId}
      AND request_ref = ${input.requestRef}
    LIMIT 1
  `;
  if (existing.length > 0) return false;
  const id = ulid();
  const createdAt = new Date().toISOString();
  const previous = await sql<{ chain_hash: Buffer; chain_sequence_text: string }[]>`
    SELECT chain_hash, chain_sequence::text AS chain_sequence_text FROM audit_event
    WHERE workspace_id = ${input.workspaceId} AND chain_version = 1
    ORDER BY chain_sequence DESC LIMIT 1
  `;
  const prevChainHash = previous[0]?.chain_hash ? Buffer.from(previous[0].chain_hash).toString("hex") : null;
  const chainSequence = String(BigInt(previous[0]?.chain_sequence_text ?? "0") + 1n);
  const payload = {
    id, workspaceId: input.workspaceId, actorKind: "system", actorId: null, action: input.action,
    targetKind: input.targetKind, targetId: input.targetId, beforeHash: null, afterHash: null,
    requestRef: input.requestRef, detail: input.detail, createdAt, chainSequence, prevChainHash,
  };
  const chainHash = createHash("sha256").update(stableJson(payload)).digest();
  await sql`
    INSERT INTO audit_event
      (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id,
       request_ref, detail, chain_version, chain_sequence, prev_chain_hash, chain_hash, chain_sealed_at, created_at)
    VALUES
      (${id}, ${input.workspaceId}, 'system', NULL, ${input.action}, ${input.targetKind}, ${input.targetId},
       ${input.requestRef}, ${sql.json(input.detail as never)}, 1, ${chainSequence},
       ${prevChainHash ? Buffer.from(prevChainHash, "hex") : null}, ${chainHash}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
  `;
  return true;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("budget audit detail must be JSON-serializable");
}

function overspendAudit(evidence: BudgetCommitEvidence): Parameters<typeof appendBudgetOperationalAudit>[1] {
  return {
    workspaceId: evidence.workspaceId,
    action: "budget.overspent",
    targetKind: "budget_reservation",
    targetId: evidence.reservationId,
    requestRef: evidence.requestId,
    detail: {
      heldMicroUsd: evidence.heldMicroUsd.toString(),
      actualMicroUsd: evidence.actualMicroUsd.toString(),
      actualTokens: evidence.actualTokens.toString(),
    },
  };
}

async function quarantineMissingReservation(
  sql: Sql, workspaceId: string, traceId: string, reservationId: string, budgetAccountId: string | null,
): Promise<void> {
  if (!budgetAccountId) throw new Error("missing reservation has no budget account to quarantine");
  await sql.begin(async (tx) => {
    await setWorkspaceGuc(tx, workspaceId);
    const account = await tx<{ id: string }[]>`
      SELECT id FROM budget_account WHERE id = ${budgetAccountId} AND workspace_id = ${workspaceId} FOR UPDATE
    `;
    if (!account[0]) throw new Error("missing reservation budget account cannot be quarantined");
    await tx`
      UPDATE budget_account SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
      WHERE id = ${budgetAccountId} AND workspace_id = ${workspaceId}
    `;
    await appendBudgetOperationalAudit(tx, {
      workspaceId, action: "budget.reconciliation_missing", targetKind: "budget_account", targetId: budgetAccountId,
      requestRef: traceId, detail: { reservationId, traceId, reason: "reservation_missing" },
    });
  });
}

/**
 * Ingest one trace's flat events: map → reduce → project → INSERT observation + usage_record +
 * cost_ledger, then
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
  // created_at (the partition + dedup key) is set DETERMINISTICALLY so a REDELIVERED trace (the ingest
  // transport is at-least-once, §8.3) collides on the (workspace_id, observation_id, created_at) unique
  // and DO NOTHING dedups it — the money-truth ledger is written at-most-once (review HIGH #12/data-F6).
  // occurredAt is derived from the trace itself; the fallback decodes the trace ULID's timestamp rather
  // than wall-clock now() (which would differ per delivery and defeat the unique).
  const occurredAt = observation.occurredAt ?? deterministicOccurredAt(observation.traceId);

  // Project-insert all three rows in ONE transaction so the queryable journal, ledger, and usage rows
  // never diverge on a partial failure (money reviewer #9). Every write is ON CONFLICT DO NOTHING,
  // so a redelivery is a clean no-op.
  //
  // Scope the tenant GUC FIRST, before either INSERT (review live-money-wiring #3): usage_record and
  // cost_ledger are FORCE-RLS workspace-scoped tables (migration 0001 §9), and their policy governs
  // INSERT's WITH CHECK too, not just SELECT. Under the RLS-subject `manifold_app` role (the
  // production connection, migration 0002) an unset GUC makes WITH CHECK reject every row: the
  // INSERT throws, the transaction rolls back, no cost_ledger row is ever written, and the caller's
  // hard-budget reservation never reconciles reserved→committed. A superuser test connection is
  // EXEMPT from RLS and would pass either way, which is exactly why this bug shipped invisibly.
  await sql.begin(async (tx) => {
    await setWorkspaceGuc(tx, workspaceId);
    await insertObservation(tx, observationId, occurredAt, observation, events, producerId, cost.amountMicroUsd);
    await insertUsageRecord(tx, observationId, occurredAt, usage);
    await insertCostLedger(tx, observationId, occurredAt, cost);
    // Provider-attempt facts are deliberately admitted in the same RLS-scoped
    // transaction as durable billing telemetry.  The health helper validates
    // ownership against the active route revision and signed snapshot, making
    // stale or forged attribution a harmless telemetry-only event.  Its stable
    // source-event id also makes a retried ingest a no-op.
    await recordProviderAttemptHealthFacts(
      tx,
      workspaceId,
      producerId,
      providerAttemptHealthFacts(events),
    );
  });

  // BUDGET RECONCILE (§8.4): move the hold reserved→committed at the ACTUAL cost AND actual tokens. The
  // reservation id rode on the flat terminal event (threaded from enforce.ts); actual µ$ is exactly what
  // we wrote to cost_ledger, and actual tokens (input+output) reconcile a unit='tokens' hard cap (#3).
  // commit() is idempotent, so a redelivery does not double-commit.
  let committed: CommitResult | undefined;
  const terminal = events.find((e) => e.kind === "terminal" && e.reservationId);
  if (terminal?.reservationId) {
    const actualTokens = usage.tokens.inputTokens + usage.tokens.outputTokens;
    committed = await commit(sql, terminal.reservationId, cost.amountMicroUsd, workspaceId, actualTokens, {
      expectedRequestId: observation.traceId,
      afterCommit: async (tx, evidence) => {
        if (evidence.overspent) await appendBudgetOperationalAudit(tx, overspendAudit(evidence));
      },
    });
    // A redelivery after a successful commit is the one expected no-op: commit() reports the
    // reservation's terminal `committed` state with ok=false. It is only safe when both its
    // durable request binding and reconciled amount match this terminal trace.
    const committedReplayMatches =
      !committed.ok &&
      committed.status === "committed" &&
      committed.requestId === observation.traceId &&
      committed.committedMicroUsd === cost.amountMicroUsd;
    if (!committed.ok && !committedReplayMatches) {
      // A genuinely missing row cannot ever reconcile. Disable the terminal's known budget
      // account and append a sealed audit/outbox event before retry/DLQ can hide undercharge.
      if (committed.status === "expired" && committed.requestId === undefined) {
        await quarantineMissingReservation(sql, workspaceId, observation.traceId, terminal.reservationId, cost.budgetAccountId);
      }
      throw new BudgetCommitInvariantError({
        workspaceId,
        traceId: observation.traceId,
        reservationId: terminal.reservationId,
        status: committed.status,
      });
    }
    if (committed.ok && committed.overspent) {
      // The reservation and cost_ledger rows are already durable money truth. Emit a structured
      // signal as well so operators can alert on the admission-vs-actual divergence without
      // dropping or retrying an otherwise fully reconciled observation.
      console.error(JSON.stringify(budgetOverspendOperationalSignal(
        workspaceId,
        observation.traceId,
        terminal.reservationId,
        cost.amountMicroUsd,
        actualTokens,
      )));
    }
  }

  return { observation, usage, cost, committed };
}

/**
 * The flat gateway event carries the stable profile ID rather than a duplicated mode. Resolve its
 * mode from the RLS-scoped ingress-profile source of truth at projection time, so an installation
 * with both profile types never has an opaque ID mistaken for a trust-model label. A trace emitted
 * before profile resolution has no profile ID; record that fact as `unknown` rather than inventing
 * a profile mode.
 */
async function profileModeFor(
  sql: Sql | TransactionSql,
  workspaceId: string,
  events: readonly HotPathObservationEvent[],
): Promise<string> {
  const profileId = events.find((event) => event.profileId.length > 0)?.profileId;
  if (!profileId) return "unknown";
  const rows = await sql<{ mode: string }[]>`
    SELECT mode
    FROM gateway_ingress_profile
    WHERE workspace_id = ${workspaceId} AND id = ${profileId}
    LIMIT 1
  `;
  return rows[0]?.mode ?? "unknown";
}

/** Gateway-core caps capture envelopes; preserve that cap at the durable adapter boundary too. */
const MAX_CAPTURE_REF_BYTES = 4 * 1024;

/** Translate a terminal capture envelope into the capture_ref shape read by the control plane. */
function captureRef(events: readonly HotPathObservationEvent[]): Record<string, unknown> | null {
  const terminal = events.find((event) => event.kind === "terminal");
  const capture = terminal?.capture;
  if (!capture || (capture.mode !== "redacted" && capture.mode !== "full")) return null;
  const redacted = capture.mode === "redacted";
  if (capture.truncated === true) return { redacted, truncated: true, bytes: 0 };
  const request = capture.request;
  const response = capture.response;
  const bytes = Buffer.byteLength(
    JSON.stringify({ ...(request ? { request } : {}), ...(response ? { response } : {}) }),
    "utf8",
  );
  if (bytes > MAX_CAPTURE_REF_BYTES) return { redacted, truncated: true, bytes: 0 };
  return {
    redacted,
    truncated: false,
    bytes,
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
  };
}

/**
 * Insert the queryable observation before its derived usage/cost rows. Its unique key shares this
 * trace's deterministic timestamp, so at-least-once redelivery cannot duplicate the projection set.
 */
async function insertObservation(
  sql: Sql | TransactionSql,
  observationId: string,
  occurredAt: string,
  observation: Observation,
  events: readonly HotPathObservationEvent[],
  installationId: string,
  amountMicroUsd: bigint,
): Promise<void> {
  const tokens = observation.tokens;
  const profileMode = await profileModeFor(sql, observation.workspaceId, events);
  const storedCaptureRef = captureRef(events);
  await sql`
    INSERT INTO observation (
      id, workspace_id, trace_id, installation_id, profile_mode,
      route_id, route_revision_id, final_provider, final_offering_id, price_revision_id,
      app_id, team_id, cost_center_id, virtual_key_id,
      status, http_status,
      input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
      cache_write_tokens, audio_input_tokens, audio_output_tokens,
      cost_microusd, cost_fidelity, attempts, failovers, reason_codes, capture_ref,
      occurred_at, created_at
    ) VALUES (
      ${observationId}, ${observation.workspaceId}, ${observation.traceId}, ${installationId}, ${profileMode},
      ${observation.routeId}, ${observation.routeRevisionId}, ${observation.finalProvider}, ${observation.finalOfferingId}, ${observation.priceRevisionId},
      ${observation.appId}, ${observation.teamId}, ${observation.costCenterId}, ${observation.virtualKeyId},
      ${observation.status}, ${observation.httpStatus},
      ${p(tokens.inputTokens)}, ${p(tokens.outputTokens)}, ${p(tokens.cacheReadTokens)}, ${p(tokens.reasoningTokens)},
      ${p(tokens.cacheWriteTokens)}, ${p(tokens.audioInputTokens)}, ${p(tokens.audioOutputTokens)},
      ${p(amountMicroUsd)}, ${observation.costFidelity}, ${observation.attempts}, ${observation.failovers},
      ${sql.json(observation.reasonCodes)}, ${storedCaptureRef === null ? null : sql.json(storedCaptureRef as Parameters<typeof sql.json>[0])},
      ${occurredAt}, ${occurredAt}
    )
    ON CONFLICT (workspace_id, trace_id, created_at) DO NOTHING
  `;
}

/**
 * Only fully attributed provider attempts can influence the target-health
 * projection.  Keep this narrow at the gateway boundary: billing reduction
 * still receives every event, while the database helper independently checks
 * current installation/snapshot/revision ownership before it accepts a fact.
 */
function providerAttemptHealthFacts(
  events: readonly HotPathObservationEvent[],
): ProviderAttemptHealthFactInput[] {
  const facts: ProviderAttemptHealthFactInput[] = [];
  for (const event of events) {
    if (
      event.kind !== "provider_attempt" ||
      !event.targetId ||
      !event.routeRevisionId ||
      !event.snapshotRevision ||
      !event.attemptOutcome
    ) continue;

    facts.push({
      sourceEventId: `${event.traceId}:${event.seq}`,
      targetId: event.targetId,
      routeRevisionId: event.routeRevisionId,
      snapshotRevisionId: event.snapshotRevision,
      outcome: event.attemptOutcome,
      httpStatus: event.status,
      reasonCodes: event.reasonCodes,
      occurredAt: event.occurredAt,
    });
  }
  return facts;
}

/** A deterministic occurred_at/created_at for a trace with no terminal timestamp: decode the trace
 *  ULID's own millisecond so a redelivery yields the SAME value (keeps the dedup unique effective).
 *  Falls back to the epoch only if the id isn't ULID-decodable — never wall-clock now(). */
function deterministicOccurredAt(traceId: string): string {
  try {
    return ulidCreatedAt(traceId).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** INSERT one `usage_record` row (SPEC §6.9). Token truth + fidelity; occurred_at is NOT NULL.
 *  created_at is set = occurredAt (deterministic) and ON CONFLICT dedups a redelivered trace (#12). */
async function insertUsageRecord(
  sql: Sql | TransactionSql,
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
      fidelity, occurred_at, created_at
    ) VALUES (
      ${ulid()}, ${u.workspaceId}, ${observationId}, ${u.traceId},
      ${p(t.inputTokens)}, ${p(t.outputTokens)}, ${p(t.cacheReadTokens)}, ${p(t.reasoningTokens)},
      ${p(t.cacheWriteTokens)}, ${p(t.audioInputTokens)}, ${p(t.audioOutputTokens)},
      ${u.fidelity}, ${occurredAt}, ${occurredAt}
    )
    ON CONFLICT (workspace_id, observation_id, created_at) DO NOTHING
  `;
}

/** INSERT one `cost_ledger` row (SPEC §6.9). Money truth; amount_microusd is the §6.10 computeCost.
 *  created_at = occurredAt + ON CONFLICT makes the money-truth write at-most-once per trace (#12). */
async function insertCostLedger(
  sql: Sql | TransactionSql,
  observationId: string,
  occurredAt: string,
  c: CostLedgerRow,
): Promise<void> {
  await sql`
    INSERT INTO cost_ledger (
      id, workspace_id, observation_id, trace_id,
      budget_account_id, cost_center_id, team_id, app_id, virtual_key_id,
      amount_microusd, fidelity, price_revision_id, offering_id, occurred_at, created_at
    ) VALUES (
      ${ulid()}, ${c.workspaceId}, ${observationId}, ${c.traceId},
      ${c.budgetAccountId}, ${c.costCenterId}, ${c.teamId}, ${c.appId}, ${c.virtualKeyId},
      ${p(c.amountMicroUsd)}, ${c.fidelity}, ${c.priceRevisionId}, ${c.offeringId}, ${occurredAt}, ${occurredAt}
    )
    ON CONFLICT (workspace_id, observation_id, created_at) DO NOTHING
  `;
}
