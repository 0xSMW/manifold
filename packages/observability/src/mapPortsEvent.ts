// packages/observability/src/mapPortsEvent.ts — the ports-flat → journal event mapper (#113).
//
// The gateway (@manifold/ports) emits a FLAT `HotPathObservationEvent` (one row per emit, no tenancy /
// dedup anchor, token counts as plain numbers, prices as decimal strings — everything the
// passthrough core can produce without importing @manifold/domain). The reducer (reduce.ts) consumes
// the RICHER journal event: kind-discriminated payloads, a (workspace_id, producer_id,
// idempotency_key) dedup anchor, `bigint` token/price math. This module is the single seam that
// bridges the two — a PURE function so it is trivially testable and carries no platform/DB import.
//
// #113 DECISION: map here rather than have the gateway emit journal-shaped events. The gateway MUST
// stay minimal (§4.2) and knows nothing of the journal's dedup semantics or the µ$ bigint math; the
// tenancy dims (workspace_id, producer_id) are installation-level context the ingest layer supplies,
// not per-request data the flat event carries. Keeping the translation in observability means the one
// place that DEFINES the journal shape also owns turning foreign events into it.
import type {
  HotPathObservationEvent,
  ObservationUsage,
  SnapshotPrice,
} from "@manifold/ports";
import { parseMicroUsdString } from "@manifold/ports/price";
import type { PriceMicroUsd, TokenCounts } from "@manifold/domain";
import type {
  AcceptedEvent,
  CostFidelity,
  JournalObservationEvent,
  ObservationStatus,
  ProviderAttemptEvent,
  ProviderAttemptOutcome,
  TerminalEvent,
} from "./events.js";

/** Installation-level context the flat event does not carry but the journal's dedup anchor needs. */
export interface JournalContext {
  /** Tenant scope — half of the reduce/dedup anchor and the row's workspace on projection (§6.8). */
  workspaceId: string;
  /** Producer (installation instance) id — the other half of the dedup anchor (§6.8). */
  producerId: string;
}

/** Widen the flat `usage` (numbers) to a `Partial<TokenCounts>` (bigint), dropping absent classes. */
function tokensFromUsage(u: ObservationUsage | undefined): Partial<TokenCounts> | undefined {
  if (!u) return undefined;
  const out: Partial<TokenCounts> = {};
  const set = (k: keyof TokenCounts, v: number | undefined): void => {
    if (v !== undefined) out[k] = BigInt(Math.max(0, Math.floor(v)));
  };
  set("inputTokens", u.inputTokens);
  set("outputTokens", u.outputTokens);
  set("cacheReadTokens", u.cacheReadTokens);
  set("reasoningTokens", u.reasoningTokens);
  set("cacheWriteTokens", u.cacheWriteTokens);
  set("audioInputTokens", u.audioInputTokens);
  set("audioOutputTokens", u.audioOutputTokens);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Widen the flat `price` (decimal strings) to `PriceMicroUsd` (bigint per §6.10). Uses the ONE
 *  shared `parseMicroUsdString` (owned next to `SnapshotPrice`), so a valid integer string maps to
 *  the SAME bigint the gateway reserve path derives; `null`/absent/empty ⇒ absent (µ$0 by §6.10). */
function priceFromSnapshot(p: SnapshotPrice | undefined): PriceMicroUsd | undefined {
  if (!p) return undefined;
  const out: PriceMicroUsd = {};
  const set = (k: keyof PriceMicroUsd, v: string | null | undefined): void => {
    const b = parseMicroUsdString(v);
    if (b !== undefined) out[k] = b;
  };
  set("inputPerMtokMicroUsd", p.inputPerMtokMicroUsd);
  set("outputPerMtokMicroUsd", p.outputPerMtokMicroUsd);
  set("cacheReadPerMtokMicroUsd", p.cacheReadPerMtokMicroUsd);
  set("cacheWritePerMtokMicroUsd", p.cacheWritePerMtokMicroUsd);
  set("reasoningPerMtokMicroUsd", p.reasoningPerMtokMicroUsd);
  set("audioInPerMtokMicroUsd", p.audioInPerMtokMicroUsd);
  set("audioOutPerMtokMicroUsd", p.audioOutPerMtokMicroUsd);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Which `PriceMicroUsd` field prices a given `TokenCounts` class (§6.10). */
const TOKEN_PRICE_KEY: Record<keyof TokenCounts, keyof PriceMicroUsd> = {
  inputTokens: "inputPerMtokMicroUsd",
  outputTokens: "outputPerMtokMicroUsd",
  cacheReadTokens: "cacheReadPerMtokMicroUsd",
  cacheWriteTokens: "cacheWritePerMtokMicroUsd",
  reasoningTokens: "reasoningPerMtokMicroUsd",
  audioInputTokens: "audioInPerMtokMicroUsd",
  audioOutputTokens: "audioOutPerMtokMicroUsd",
};

/**
 * Derive `costFidelity` (§6.10) from the WIDENED tokens/price. `exact` requires that EVERY token
 * class with a positive count has a matching price; a class billed with no price makes the
 * projected cost a floor, not an exact figure, so it must downgrade to `estimated` (partially
 * priced) rather than masquerade as `exact` (an under-count must never look authoritative).
 * `unknown` when there is no billed usage to price at all.
 */
function costFidelityFor(
  tokens: Partial<TokenCounts> | undefined,
  price: PriceMicroUsd | undefined,
): CostFidelity {
  if (!tokens) return "unknown";
  const billedClasses = (Object.keys(tokens) as (keyof TokenCounts)[]).filter(
    (k) => (tokens[k] ?? 0n) > 0n,
  );
  if (billedClasses.length === 0) return "unknown";
  if (!price) return "unknown";
  const allPriced = billedClasses.every((k) => price[TOKEN_PRICE_KEY[k]] !== undefined);
  return allPriced ? "exact" : "estimated";
}

/** Map a flat event's HTTP status + reason codes to the durable `observation.status` set (§6.8). */
function mapStatus(e: HotPathObservationEvent): ObservationStatus {
  const codes = e.reasonCodes;
  if (codes.some((c) => c === "PROVIDER_TIMEOUT")) return "timeout";
  if (codes.some((c) => c === "BUDGET_RESERVE_DENIED" || c.startsWith("POLICY_"))) return "denied";
  const s = e.status ?? 0;
  if (s >= 200 && s < 300) return "ok";
  if (s === 402 || s === 403) return "denied";
  return s === 0 ? "ok" : "error";
}

function mapOutcome(status: number | null): ProviderAttemptOutcome {
  const s = status ?? 0;
  if (s >= 200 && s < 300) return "ok";
  return "error";
}

/**
 * Map ONE flat `HotPathObservationEvent` to the journal event `reduce()` consumes. The dedup
 * anchor is `(workspaceId, producerId, `${traceId}:${seq}`)`: `seq` is unique per (trace, producer),
 * so re-delivery of the SAME emit collapses (idempotent) while distinct emits never collide.
 */
export function journalFromPortsEvent(
  e: HotPathObservationEvent,
  ctx: JournalContext,
): JournalObservationEvent {
  const base = {
    workspaceId: ctx.workspaceId,
    traceId: e.traceId,
    producerId: ctx.producerId,
    idempotencyKey: `${e.traceId}:${e.seq}`,
    seq: e.seq,
    occurredAt: e.occurredAt,
  };

  if (e.kind === "accepted") {
    const accepted: AcceptedEvent = {
      ...base,
      kind: "accepted",
      payload: {
        ...(e.routeId ? { routeId: e.routeId } : {}),
        ...(e.keyId ? { virtualKeyId: e.keyId } : {}),
        ...(e.budgetAccountId ? { budgetAccountId: e.budgetAccountId } : {}),
      },
    };
    return accepted;
  }

  if (e.kind === "provider_attempt") {
    const attempt: ProviderAttemptEvent = {
      ...base,
      kind: "provider_attempt",
      payload: {
        provider: e.offeringId ?? "",
        ...(e.offeringId ? { offeringId: e.offeringId } : {}),
        outcome: mapOutcome(e.status),
        ...(e.status !== null ? { httpStatus: e.status } : {}),
        ...(e.reasonCodes.length > 0 ? { reasonCodes: e.reasonCodes } : {}),
      },
    };
    return attempt;
  }

  const tokens = tokensFromUsage(e.usage);
  const price = priceFromSnapshot(e.price);
  const terminal: TerminalEvent = {
    ...base,
    kind: "terminal",
    payload: {
      status: mapStatus(e),
      ...(e.status !== null ? { httpStatus: e.status } : {}),
      ...(tokens ? { tokens } : {}),
      ...(price ? { price } : {}),
      // Cost fidelity is `exact` only when EVERY billed token class has a matching price; a
      // partially-priced usage record is `estimated`, never `exact` (§6.10) — an under-count must
      // not masquerade as authoritative.
      costFidelity: costFidelityFor(tokens, price),
      ...(e.offeringId ? { finalOfferingId: e.offeringId } : {}),
      ...(e.priceRevisionId ? { priceRevisionId: e.priceRevisionId } : {}),
      ...(e.budgetAccountId ? { budgetAccountId: e.budgetAccountId } : {}),
      ...(e.keyId ? { virtualKeyId: e.keyId } : {}),
      // Carry the HotPath reasonCodes (POLICY_*/AUTH_*/SSRF_*/etc.) into the journal terminal so
      // the reduced Observation retains the denial cause — mapStatus() alone only derives the
      // coarse `status`, dropping the specific reason if not also threaded through here (§6.8).
      ...(e.reasonCodes.length > 0 ? { reasonCodes: e.reasonCodes } : {}),
    },
  };
  return terminal;
}

/** Map every flat event of a trace to its journal event (convenience over `journalFromPortsEvent`). */
export function journalFromPortsEvents(
  events: readonly HotPathObservationEvent[],
  ctx: JournalContext,
): JournalObservationEvent[] {
  return events.map((e) => journalFromPortsEvent(e, ctx));
}
