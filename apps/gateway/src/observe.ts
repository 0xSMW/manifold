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
import { commit, ulid, ulidCreatedAt, type CommitResult } from "@manifold/budget";
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
    committed = await commit(sql, terminal.reservationId, cost.amountMicroUsd, workspaceId, actualTokens);
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
