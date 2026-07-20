// @manifold/gateway-policy — the deny-first evaluator (SPEC §11 Policies, §14, §0.2).
//
// This is the SINGLE pure function the gateway authorizer and the Policies simulator both
// run, so their decisions are provably identical (SPEC §21.5 parity property test). It takes
// no ports, no clock, no DB — verdict is a pure function of (input, revision).
import type { ReasonCode } from "@manifold/contracts";
import type {
  ModelEntitlement,
  PolicyDecision,
  PolicyInput,
  PolicyRevision,
  PolicySubject,
} from "./types.js";

// Reason codes this evaluator can emit (SPEC §0.2, policy class). Typed to `ReasonCode` so a
// typo or a code removed from the contracts registry fails `tsc`.
const POLICY_MODEL_DENIED: ReasonCode = "POLICY_MODEL_DENIED";
const POLICY_PARAM_CLAMPED: ReasonCode = "POLICY_PARAM_CLAMPED";
const POLICY_PARAM_REJECTED: ReasonCode = "POLICY_PARAM_REJECTED";

/**
 * Does `ent` apply to this request's subject? `all` always matches; a scoped kind matches
 * only when the request carries that facet AND it equals the entitlement's `subjectRef`.
 * An absent facet never matches (deny-first: silence is not consent).
 */
function subjectMatches(ent: ModelEntitlement, subject: PolicySubject): boolean {
  if (ent.subjectKind === "all") return true;
  if (ent.subjectRef === null) return false; // a scoped kind with no ref matches nothing
  const facet =
    ent.subjectKind === "key_scope"
      ? subject.keyScope
      : ent.subjectKind === "team"
        ? subject.team
        : ent.subjectKind === "cost_center"
          ? subject.costCenter
          : ent.subjectKind === "app"
            ? subject.app
            : undefined;
  return facet !== undefined && facet === ent.subjectRef;
}

/** Does `ent` apply to this request's model? A `null` model on the grant is a wildcard. */
function modelMatches(ent: ModelEntitlement, canonicalModelId: string): boolean {
  return ent.canonicalModelId === null || ent.canonicalModelId === canonicalModelId;
}

/**
 * Evaluate a request against a policy revision, deny-first.
 *
 * Rule 1 — model entitlement (SPEC §6.6, §0.2 `POLICY_MODEL_DENIED`):
 *   Over the entitlements matching this subject AND this model, an explicit `deny` ALWAYS
 *   wins (even if an `allow` also matches). With no matching `allow`, the request is denied
 *   by default. Only when a matching `allow` exists and no matching `deny` does evaluation
 *   proceed to constraints.
 *
 * Rule 2 — request constraints (SPEC §6.6, §0.2 `POLICY_PARAM_CLAMPED` / `POLICY_PARAM_REJECTED`):
 *   For each constraint whose `param` is present, a value strictly over `maxValue` (or
 *   strictly under `minValue`) is either CLAMPED to the bound (`outcome: 'clamp'`, records the
 *   clamped value) or REJECTED (`outcome: 'deny'`) per `onViolation`. A value exactly at a
 *   bound is in-range and untouched. A reject is a deny, so deny-first holds across both rules.
 */
export function evaluate(input: PolicyInput, policy: PolicyRevision): PolicyDecision {
  // ---- Rule 1: model entitlement (deny-first) ----
  const matching = policy.modelEntitlements.filter(
    (ent) => subjectMatches(ent, input.subject) && modelMatches(ent, input.canonicalModelId),
  );
  const explicitDeny = matching.some((ent) => ent.effect === "deny");
  const hasAllow = matching.some((ent) => ent.effect === "allow");

  // Explicit deny wins over any allow; absence of an allow is a deny-by-default. Either way
  // the model is denied and we stop here — a denied model is not clamped or partially allowed.
  if (explicitDeny || !hasAllow) {
    return { outcome: "deny", reasonCodes: [POLICY_MODEL_DENIED] };
  }

  // ---- Rule 2: request constraints ----
  const reasonCodes: string[] = [];
  const clamps: Record<string, number> = {};
  let rejected = false;
  let clamped = false;

  for (const c of policy.requestConstraints) {
    const value = input.params[c.param];
    if (value === undefined) continue; // constraint does not apply to this request

    const overMax = c.maxValue !== null && value > c.maxValue;
    const underMin = c.minValue !== null && value < c.minValue;
    if (!overMax && !underMin) continue; // in range (boundary values included) — untouched

    if (c.onViolation === "reject") {
      rejected = true;
      if (!reasonCodes.includes(POLICY_PARAM_REJECTED)) reasonCodes.push(POLICY_PARAM_REJECTED);
    } else {
      // clamp to the violated bound (over→max, under→min)
      const bound = overMax ? (c.maxValue as number) : (c.minValue as number);
      clamps[c.param] = bound;
      clamped = true;
      if (!reasonCodes.includes(POLICY_PARAM_CLAMPED)) reasonCodes.push(POLICY_PARAM_CLAMPED);
    }
  }

  // Deny-first across the whole verdict: any rejection denies the request outright.
  if (rejected) {
    return Object.keys(clamps).length > 0
      ? { outcome: "deny", reasonCodes, clamps }
      : { outcome: "deny", reasonCodes };
  }
  if (clamped) {
    return { outcome: "clamp", reasonCodes, clamps };
  }
  return { outcome: "allow", reasonCodes: [] };
}
