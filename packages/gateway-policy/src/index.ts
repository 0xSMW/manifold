// @manifold/gateway-policy — public entrypoint (SPEC §4.3).
//
// The deny-first policy evaluator + reason codes, pure and identical in the gateway
// authorizer and the Policies simulator (SPEC §11 Policies, §21.5). Depends ONLY on
// @manifold/contracts and @manifold/domain — no platform, no DB imports (SPEC §4.2).
export { evaluate } from "./evaluate.js";
export type {
  EntitlementEffect,
  ModelEntitlement,
  OnViolation,
  PolicyDecision,
  PolicyInput,
  PolicyRevision,
  PolicySubject,
  ReasonCode,
  RequestConstraint,
  SubjectKind,
} from "./types.js";
