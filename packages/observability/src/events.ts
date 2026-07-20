// packages/observability/src/events.ts — the append-only journal event, as the reducer sees it.
//
// Mirrors the columns of `observation_event` (SPEC §6.8) that the deterministic reduction
// (ADR-0011) actually reads. The journal is idempotent and dedup'd on
// (workspace_id, producer_id, idempotency_key) (§6.8, §8.3); those three fields are the
// dedup anchor the reducer uses as its cross-partition backstop.
import type { ReasonCode } from "@manifold/contracts";
import type { PriceMicroUsd, TokenCounts } from "@manifold/domain";

/** The terminal-observation status set (SPEC §6.8 `observation.status`). */
export type ObservationStatus = "ok" | "error" | "denied" | "clamped" | "timeout";

/** SPEC §6.10 price fidelity carried into `usage_record`/`cost_ledger`. */
export type CostFidelity = "exact" | "estimated" | "unknown";

/** The single provider attempt outcome recorded on a `provider_attempt` event. */
export type ProviderAttemptOutcome = "ok" | "error" | "timeout";

/** Fields present on every journal event (SPEC §6.8). */
export interface BaseEvent {
  workspaceId: string;
  traceId: string;
  /** Installation instance id — half of the dedup anchor (§6.8). */
  producerId: string;
  /** Dedup anchor within (workspace, producer) (§6.8). */
  idempotencyKey: string;
  /** Producer sequence within (trace, producer) — primary sort key (§8.3, §16.6). */
  seq: number;
  /** ISO-8601 timestamp — secondary sort key (§8.3, §16.6). */
  occurredAt: string;
}

/** `accepted` — request admitted; carries routing/tenancy dims. */
export interface AcceptedEvent extends BaseEvent {
  kind: "accepted";
  payload: {
    installationId?: string;
    profileMode?: string;
    routeId?: string;
    routeRevisionId?: string;
    endpointKind?: string;
    publicName?: string;
    appId?: string;
    actionId?: string;
    teamId?: string;
    costCenterId?: string;
    virtualKeyId?: string;
    budgetAccountId?: string;
  };
}

/** `provider_attempt` — one dispatch to a provider (a retry or failover is another such event). */
export interface ProviderAttemptEvent extends BaseEvent {
  kind: "provider_attempt";
  payload: {
    provider: string;
    offeringId?: string;
    outcome: ProviderAttemptOutcome;
    httpStatus?: number;
    /** Tokens this attempt produced, if any. A retry that produced no bytes omits this. */
    tokens?: Partial<TokenCounts>;
    reasonCodes?: ReasonCode[];
  };
}

/** `terminal` — the request's final outcome; authoritative token counts, price, fidelity. */
export interface TerminalEvent extends BaseEvent {
  kind: "terminal";
  payload: {
    status: ObservationStatus;
    httpStatus?: number;
    tokens?: Partial<TokenCounts>;
    /** Per-mtok µ$ prices resolved at dispatch (SPEC §6.10) — cost input for `project`. */
    price?: PriceMicroUsd;
    costFidelity?: CostFidelity;
    finalProvider?: string;
    finalOfferingId?: string;
    priceRevisionId?: string;
    reasonCodes?: ReasonCode[];
    // Cost-ledger dims (SPEC §6.9).
    budgetAccountId?: string;
    costCenterId?: string;
    teamId?: string;
    appId?: string;
    virtualKeyId?: string;
  };
}

/** `annotation` — mutable side note; never contributes to the deterministic reduction. */
export interface AnnotationEvent extends BaseEvent {
  kind: "annotation";
  payload: Record<string, unknown>;
}

export type ObservationEvent =
  | AcceptedEvent
  | ProviderAttemptEvent
  | TerminalEvent
  | AnnotationEvent;
