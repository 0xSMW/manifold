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

    // A non-finite param value (NaN / ±Infinity) can NEVER be proven in-range against a
    // numeric ceiling: `NaN > max` and `NaN < min` are both false, so a raw `>`/`<` check
    // would silently pass it through as `allow` — a hard param ceiling that never fires.
    // Fail closed: whenever the constraint bounds this param at all, a non-finite value is a
    // violation (clamped to a finite bound or rejected per `onViolation`), same as an
    // out-of-range finite value. (`Infinity` already trips `overMax` on a max ceiling, but a
    // min-only or NaN case would slip through without this guard.)
    const nonFinite = !Number.isFinite(value);
    const bounded = c.maxValue !== null || c.minValue !== null;

    const overMax = c.maxValue !== null && value > c.maxValue;
    const underMin = c.minValue !== null && value < c.minValue;
    if (!overMax && !underMin && !(nonFinite && bounded)) continue; // in range — untouched

    if (c.onViolation === "reject") {
      rejected = true;
      if (!reasonCodes.includes(POLICY_PARAM_REJECTED)) reasonCodes.push(POLICY_PARAM_REJECTED);
    } else {
      // Clamp to the violated bound (over→max, under→min). A non-finite value has no
      // meaningful "side", so clamp it to whichever finite bound exists (prefer the max
      // ceiling) — it must land on a finite, in-range value.
      const bound = overMax
        ? (c.maxValue as number)
        : underMin
          ? (c.minValue as number)
          : c.maxValue !== null
            ? c.maxValue
            : (c.minValue as number);
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

/**
 * Evaluate a policy for every subject facet carried by an authenticated key.
 *
 * The gateway authorizer uses this when a key has multiple scopes/apps: every
 * subject must be entitled (deny-first), while constraints are evaluated once
 * because they are subject-independent. The Policies simulator passes exactly
 * one subject through this same adapter, keeping its result on the production
 * authorization path rather than a lookalike implementation.
 */
export function evaluateForSubjects(
  input: Omit<PolicyInput, "subject">,
  policy: PolicyRevision,
  subjects: readonly PolicySubject[],
): PolicyDecision {
  // An authenticated key always supplies at least one subject. Treat a malformed empty set as
  // no entitlement rather than accidentally allowing it through a vacuous loop.
  if (subjects.length === 0) {
    return { outcome: "deny", reasonCodes: [POLICY_MODEL_DENIED] };
  }

  // Entitlements are subject-dependent. Check all subjects before constraints so an explicit
  // deny on any facet always wins over an otherwise rejecting/clamping parameter.
  const entitlementOnly: PolicyRevision = {
    modelEntitlements: policy.modelEntitlements,
    requestConstraints: [],
  };
  for (const subject of subjects) {
    const entitlement = evaluate({ ...input, subject }, entitlementOnly);
    if (entitlement.outcome === "deny") return entitlement;
  }

  // Constraints are independent of the subject. One allowed subject is sufficient here because
  // every subject was already proven entitled above.
  return evaluate({ ...input, subject: subjects[0]! }, policy);
}
