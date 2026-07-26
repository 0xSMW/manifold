/** Pure hard-budget release-contract checks, shared by the k6 summary and Node tests. */
export function positiveInteger(value, name = "MANIFOLD_HARD_BUDGET_SUCCESS_CAP") {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function evaluateReleaseSummary({ profile, cap, successfulDispatches, budgetDenials }) {
  if (profile === "enterprise_egress") {
    const intended = positiveInteger(String(cap));
    if (successfulDispatches !== intended) return `hard-budget success count ${successfulDispatches} does not equal intended cap ${intended}`;
    if (budgetDenials < 1) return "hard-budget transition missing: expected at least one HTTP 402 BUDGET_RESERVE_DENIED";
    return null;
  }
  if (successfulDispatches < 1) return "public profile produced no successful dispatched response";
  return null;
}
