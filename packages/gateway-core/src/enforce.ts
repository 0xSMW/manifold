// enforceRequest — the policy + hard-budget authorization step (SPEC §11 Policies, §16.3 budget,
// review bug #9). Runs AFTER authenticate + resolveRoute and BEFORE SSRF/dispatch. A denied model
// or an over-cap hard budget MUST NOT reach the provider — this is the gate that makes that true.
//
// gateway-core stays pure: policy is the pure @manifold/gateway-policy evaluator (allowed by §4.2);
// the hard-budget reservation goes through the injected BudgetReserver PORT (ADR-0012/§4.4) — no
// @manifold/budget, no DB import here.
import { evaluate, type PolicySubject } from "@manifold/gateway-policy";
import type {
  BudgetReserver,
  Snapshot,
  SnapshotKey,
  SnapshotPolicyRevision,
  SnapshotProfile,
} from "@manifold/ports";

/**
 * Enforcement verdict. On `ok`, `forwardBody` (when present) is the request body the caller MUST
 * forward upstream instead of the original stream — it reflects any policy clamp AND the fact that
 * we already consumed the request body to read the model/params. `undefined` means the fast path
 * (no policy, no hard budget) ran: the body was never touched and the caller streams it through.
 */
export type EnforceResult =
  | { ok: true; forwardBody?: string }
  | { ok: false; code: string; message: string };

export interface EnforceArgs {
  snapshot: Snapshot;
  profile: SnapshotProfile;
  key: SnapshotKey;
  request: Request;
  /** Trace id — the idempotency anchor for a budget reservation. */
  traceId: string;
  /** Injected hard-budget reserver (ADR-0012). Absent ⇒ a hard budget cannot be honored → fail closed. */
  reserveBudget?: BudgetReserver["reserve"];
}

/** Build the policy subject from the authenticated key's facets (SPEC §6.6). Absent facets are
 *  omitted so they never match a scoped entitlement (deny-first: silence is not consent). */
function subjectFromKey(key: SnapshotKey): PolicySubject {
  const subject: PolicySubject = {};
  const scope = key.scopes[0];
  if (scope !== undefined) subject.keyScope = scope;
  const app = key.allowedAppIds[0];
  if (app !== undefined) subject.app = app;
  if (key.team) subject.team = key.team;
  if (key.costCenter) subject.costCenter = key.costCenter;
  return subject;
}

/** Collect the finite numeric top-level params (max_tokens, temperature, top_p, …) the policy
 *  constraints operate on. Non-numeric fields (model, messages, …) are ignored. */
function numericParams(obj: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Pre-dispatch cost estimate in µ$ (SPEC §6.10). PLACEHOLDER: the real estimator multiplies
 * input-token estimate + max_output by the offering's per-token price; on this skeleton path we
 * proxy it with the requested output ceiling so the reserve guard has a monotone, non-zero number.
 * The BudgetReserver adapter is free to recompute a precise estimate.
 */
function estimateMicroUsd(params: Record<string, number>): bigint {
  const maxOut = params.max_tokens ?? params.max_output_tokens ?? 0;
  return BigInt(Math.max(1, Math.ceil(maxOut)));
}

export async function enforceRequest(args: EnforceArgs): Promise<EnforceResult> {
  const { snapshot, profile, key, request, traceId, reserveBudget } = args;

  const policy: SnapshotPolicyRevision | undefined = profile.policyRevision
    ? snapshot.policies?.[profile.policyRevision]
    : undefined;
  const budgetAccountId = key.budgetAccountId;
  const budget = budgetAccountId ? snapshot.budgets?.[budgetAccountId] : undefined;
  const hardBudget = budget?.enforcement === "hard";

  // Fast path: nothing to enforce. Do NOT read the body — the request stream stays untouched so
  // response streaming and every existing (policy/budget-free) test behave exactly as before.
  if (!policy && !hardBudget) return { ok: true };

  // Enforcement is active: buffer the (small) request body to read model + numeric params. Only the
  // REQUEST is buffered here; the RESPONSE is still streamed with flat memory downstream.
  const rawBody = request.body ? await request.text() : "";
  let parsed: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      const j = JSON.parse(rawBody) as unknown;
      if (j && typeof j === "object") parsed = j as Record<string, unknown>;
    } catch {
      parsed = null; // unparseable body → empty model/params (deny-first will handle it)
    }
  }
  const model = parsed && typeof parsed.model === "string" ? parsed.model : "";
  const params = parsed ? numericParams(parsed) : {};

  // Default: forward exactly what we buffered (unchanged unless a clamp rewrites it below).
  let forwardBody = rawBody;

  // ── Policy (deny-first) ──────────────────────────────────────────────────
  if (policy) {
    const decision = evaluate({ subject: subjectFromKey(key), canonicalModelId: model, params }, policy);
    if (decision.outcome === "deny") {
      // Carry the evaluator's own code (POLICY_MODEL_DENIED, or POLICY_PARAM_REJECTED for a
      // rejecting constraint) so the status map and terminal event report the real reason.
      const code = decision.reasonCodes[0] ?? "POLICY_MODEL_DENIED";
      return { ok: false, code, message: `request denied by policy (${code})` };
    }
    if (decision.outcome === "clamp" && decision.clamps && parsed) {
      // Rewrite the clamped params back into the forwarded body — the provider sees the safe values.
      for (const [param, value] of Object.entries(decision.clamps)) parsed[param] = value;
      forwardBody = JSON.stringify(parsed);
    }
  }

  // ── Hard budget reservation (strong consistency, §16.3) ──────────────────
  if (hardBudget) {
    if (!reserveBudget) {
      // A hard budget with no reserver wired cannot be honored: fail closed rather than dispatch
      // an unmetered request that could blow the cap.
      return { ok: false, code: "BUDGET_RESERVE_DENIED", message: "budget reserver unavailable" };
    }
    const reservation = await reserveBudget({
      budgetAccountId: budgetAccountId!,
      requestId: traceId,
      estMicroUsd: estimateMicroUsd(params),
    });
    if (!reservation.ok) {
      return { ok: false, code: "BUDGET_RESERVE_DENIED", message: "budget cap exceeded" };
    }
  }

  return { ok: true, forwardBody };
}
