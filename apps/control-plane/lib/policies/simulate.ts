import {
  evaluateForSubjects,
  type PolicyDecision,
  type PolicyInput,
  type PolicyRevision,
} from "@manifold/gateway-policy";

/**
 * Run the policy simulator through the exact multi-subject adapter used by the
 * gateway authorizer. The UI/API simulator represents one concrete subject.
 */
export function simulatePolicy(input: PolicyInput, revision: PolicyRevision): PolicyDecision {
  const { subject, ...request } = input;
  return evaluateForSubjects(request, revision, [subject]);
}
