// @manifold/gateway-policy — input/output shapes for the deny-first evaluator.
//
// Pure. Imports ONLY @manifold/contracts (for the reason-code vocabulary) and, where
// useful, @manifold/domain. No platform, no DB, no zod-at-runtime here (SPEC §4.2, §4.3).
//
// These mirror the governance schema in SPEC §6.6 (`model_entitlement`,
// `request_constraint`) as pure in-memory value shapes so the SAME function runs in the
// gateway authorizer and the Policies simulator (SPEC §11 Policies, §21.5).
import type { ReasonCode } from "@manifold/contracts";

/** Which class of subject a `ModelEntitlement` grants to (SPEC §6.6 `subject_kind`). */
export type SubjectKind = "key_scope" | "team" | "cost_center" | "app" | "all";

/** Effect of an entitlement (SPEC §6.6 `effect`). */
export type EntitlementEffect = "allow" | "deny";

/** What a constraint does when a param is out of bounds (SPEC §6.6 `on_violation`). */
export type OnViolation = "clamp" | "reject";

/**
 * A single subject→model grant (SPEC §6.6 `model_entitlement`).
 * `subjectRef` is `null` for `subject_kind = 'all'`. `canonicalModelId = null` means the
 * grant is not scoped to a specific model (applies to every model).
 */
export interface ModelEntitlement {
  subjectKind: SubjectKind;
  subjectRef: string | null;
  canonicalModelId: string | null;
  effect: EntitlementEffect;
}

/**
 * A token/param ceiling (SPEC §6.6 `request_constraint`). `maxValue`/`minValue` are
 * fractional-capable bounds (params can be non-integer, e.g. `temperature`). `null` means
 * that side is unbounded.
 */
export interface RequestConstraint {
  param: string;
  maxValue: number | null;
  minValue: number | null;
  onViolation: OnViolation;
}

/**
 * The immutable, content-addressed policy revision the evaluator reads (SPEC §11 Policies).
 * An empty revision (no entitlements) denies by default (SPEC §14, deny-first).
 */
export interface PolicyRevision {
  modelEntitlements: ModelEntitlement[];
  requestConstraints: RequestConstraint[];
}

/**
 * The facets of the calling principal an entitlement can match against. A request may
 * carry several (a key scope AND a team AND a cost center AND an app); `subject_kind = 'all'`
 * matches regardless. Facets that are absent (`undefined`) never match a scoped entitlement.
 */
export interface PolicySubject {
  keyScope?: string;
  team?: string;
  costCenter?: string;
  app?: string;
}

/** The request shape presented to `evaluate` (SPEC §11 Policies simulator input). */
export interface PolicyInput {
  subject: PolicySubject;
  canonicalModelId: string;
  /** Numeric request params keyed by name: `max_tokens`, `temperature`, `top_p`, … */
  params: Record<string, number>;
}

/** The evaluator verdict. `clamps` records the post-clamp value per clamped param. */
export interface PolicyDecision {
  outcome: "allow" | "clamp" | "deny";
  reasonCodes: string[];
  clamps?: Record<string, number>;
}

/** Re-export for callers that want to assert against the contracts vocabulary. */
export type { ReasonCode };
