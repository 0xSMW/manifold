// enforceRequest — the policy + hard-budget authorization step (SPEC §11 Policies, §16.3 budget,
// review bug #9). Runs AFTER authenticate + resolveRoute and BEFORE SSRF/dispatch. A denied model
// or an over-cap hard budget MUST NOT reach the provider — this is the gate that makes that true.
//
// gateway-core stays pure: policy is the pure @manifold/gateway-policy evaluator (allowed by §4.2);
// the hard-budget reservation goes through the injected BudgetReserver PORT (ADR-0012/§4.4) — no
// @manifold/budget, no DB import here.
import { evaluate, type PolicyDecision, type PolicySubject } from "@manifold/gateway-policy";
import type {
  BudgetReserver,
  Snapshot,
  SnapshotKey,
  SnapshotPolicyRevision,
  SnapshotPrice,
  SnapshotProfile,
  SnapshotTarget,
} from "@manifold/ports";

/**
 * Enforcement verdict. On `ok`, `forwardBody` (when present) is the request body the caller MUST
 * forward upstream instead of the original stream — it reflects any policy clamp AND the fact that
 * we already consumed the request body to read the model/params. `undefined` means the fast path
 * (no policy, no hard budget) ran: the body was never touched and the caller streams it through.
 */
export type EnforceResult =
  | { ok: true; forwardBody?: string; reservationId?: string }
  | { ok: false; code: string; message: string };

export interface EnforceArgs {
  snapshot: Snapshot;
  profile: SnapshotProfile;
  key: SnapshotKey;
  request: Request;
  /** Trace id (a ULID) — the idempotency anchor + created_at source for a budget reservation. */
  traceId: string;
  /** The dispatch target selected for this request; its offering price drives the reserve estimate (§6.10). */
  target: SnapshotTarget;
  /** Injected hard-budget reserver (ADR-0012). Absent ⇒ a hard budget cannot be honored → fail closed. */
  reserveBudget?: BudgetReserver["reserve"];
}

/**
 * Every policy subject the authenticated key carries (SPEC §6.6): the cartesian product of its
 * scopes × allowed apps, each also stamped with the key's team + cost-center facets. A key with
 * several scopes/apps is enforced under ALL of them (deny-first) — an explicit deny on ANY scope or
 * app blocks the request. The pre-fix code fed only `scopes[0]`/`allowedAppIds[0]` to the evaluator,
 * so a deny on any non-first scope/app slipped through (under-enforcement). Absent facets are
 * omitted so they never match a scoped entitlement (silence is not consent).
 */
function subjectsFromKey(key: SnapshotKey): PolicySubject[] {
  const base: PolicySubject = {};
  if (key.team) base.team = key.team;
  if (key.costCenter) base.costCenter = key.costCenter;
  // Empty scopes/apps ⇒ a single base subject (identical to the old single-facet behavior) so a
  // key with no scope/app facets is still evaluated once against `all`-subject entitlements.
  const scopes: (string | undefined)[] = key.scopes.length > 0 ? key.scopes : [undefined];
  const apps: (string | undefined)[] = key.allowedAppIds.length > 0 ? key.allowedAppIds : [undefined];
  const subjects: PolicySubject[] = [];
  for (const scope of scopes) {
    for (const app of apps) {
      const subject: PolicySubject = { ...base };
      if (scope !== undefined) subject.keyScope = scope;
      if (app !== undefined) subject.app = app;
      subjects.push(subject);
    }
  }
  return subjects;
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

/** µ$ per 1,000,000 tokens — the §6.10 price denominator. */
const MICRO_PER_MTOK = 1_000_000n;

/**
 * Parse a §6.10 per-mtok price (a DECIMAL µ$ string, per `SnapshotPrice`) to a non-negative bigint,
 * truncating any fractional µ$. Absent / empty / unparseable ⇒ 0 (that token class is unpriced).
 */
function priceMtok(v: string | null | undefined): bigint {
  if (!v) return 0n;
  const digits = (v.trim().split(".")[0] ?? "").replace(/[^0-9]/g, "");
  if (digits === "") return 0n;
  const n = BigInt(digits);
  return n > 0n ? n : 0n;
}

/** Rough input-token estimate from the buffered request body (~4 chars/token): a monotone,
 *  non-zero proxy for prompt size until a real tokenizer lands on this path. */
function estimateInputTokens(rawBody: string): bigint {
  return BigInt(Math.ceil(rawBody.length / 4));
}

/** A completion envelope worth policing is small; anything larger cannot be a model/params body.
 *  Cap the buffered read so an authenticated client can't OOM the shared gateway with a giant POST
 *  (review HIGH #6). */
const MAX_ENFORCE_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * Read the request body into a string, aborting past `maxBytes`. Returns `null` on overflow so the
 * caller fails closed (413) instead of buffering unbounded memory. Unlike `request.text()`, this
 * enforces a hard ceiling even for `Transfer-Encoding: chunked` bodies with no Content-Length.
 */
async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Pre-dispatch reservation estimate in µ$ (SPEC §6.10). Now that the offering price rides in the
 * snapshot, compute the REAL estimate `input_est·input_price + max_out·output_price` from the
 * dispatch target's price. Absent a price (unknown fidelity) we fall back to the requested output
 * ceiling as a bare token-count proxy so the reserve guard still has a monotone, non-zero number
 * (never 0, which would make the hard-budget guard a no-op). The value is floored at 1 µ$.
 */
function reservedEstimateMicroUsd(
  rawBody: string,
  params: Record<string, number>,
  price: SnapshotPrice | undefined,
): bigint {
  const maxOut = BigInt(Math.max(0, Math.ceil(params.max_tokens ?? params.max_output_tokens ?? 0)));
  const inputPrice = priceMtok(price?.inputPerMtokMicroUsd);
  const outputPrice = priceMtok(price?.outputPerMtokMicroUsd);
  if (inputPrice === 0n && outputPrice === 0n) {
    return maxOut > 0n ? maxOut : 1n; // no price → token-count proxy, floored at 1 µ$
  }
  const inputEst = estimateInputTokens(rawBody);
  const est = (inputEst * inputPrice) / MICRO_PER_MTOK + (maxOut * outputPrice) / MICRO_PER_MTOK;
  return est > 0n ? est : 1n;
}

export async function enforceRequest(args: EnforceArgs): Promise<EnforceResult> {
  const { snapshot, profile, key, request, traceId, target, reserveBudget } = args;

  const policyRevisionId = profile.policyRevision;
  const policy: SnapshotPolicyRevision | undefined = policyRevisionId
    ? snapshot.policies?.[policyRevisionId]
    : undefined;
  // Fail CLOSED on referential drift (review HIGH #5): the profile DECLARES a policy revision but the
  // signed snapshot does not carry it (partial/stale build, dropped section). Enforcement cannot run,
  // so deny — do NOT wave the request through the fast path unfiltered.
  if (policyRevisionId && !policy) {
    return {
      ok: false,
      code: "POLICY_MODEL_DENIED",
      message: "declared policy revision missing from snapshot",
    };
  }
  const budgetAccountId = key.budgetAccountId;
  const budget = budgetAccountId ? snapshot.budgets?.[budgetAccountId] : undefined;
  const hardBudget = budget?.enforcement === "hard";

  // Fast path: nothing to enforce. Do NOT read the body — the request stream stays untouched so
  // response streaming and every existing (policy/budget-free) test behave exactly as before.
  if (!policy && !hardBudget) return { ok: true };

  // Enforcement is active: buffer the (small) request body to read model + numeric params. Only the
  // REQUEST is buffered here; the RESPONSE is still streamed with flat memory downstream.
  const rawBody = await readBodyCapped(request, MAX_ENFORCE_BODY_BYTES);
  if (rawBody === null) {
    return {
      ok: false,
      code: "POLICY_BODY_TOO_LARGE",
      message: "request body exceeds the enforcement size limit",
    };
  }
  let parsed: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      const j = JSON.parse(rawBody) as unknown;
      if (j && typeof j === "object") parsed = j as Record<string, unknown>;
    } catch {
      parsed = null; // unparseable body → empty model/params (deny-first will handle it)
    }
  }
  // Fail CLOSED on a non-finite numeric param (review MED config-F7): JSON.parse turns `1e999` into
  // Infinity; if it were merely dropped, a max_tokens ceiling would be silently bypassed and the raw
  // value forwarded upstream. Reject before policy/reserve so the guard cannot be sidestepped.
  if (parsed) {
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && !Number.isFinite(v)) {
        return {
          ok: false,
          code: "POLICY_PARAM_REJECTED",
          message: `non-finite numeric parameter: ${k}`,
        };
      }
    }
  }
  const model = parsed && typeof parsed.model === "string" ? parsed.model : "";
  const params = parsed ? numericParams(parsed) : {};

  // Default: forward exactly what we buffered (unchanged unless a clamp rewrites it below).
  let forwardBody = rawBody;
  // The hard-budget reservation to reconcile on the terminal event (§8.4); undefined unless a
  // hard budget actually reserved below.
  let reservationId: string | undefined;

  // ── Policy (deny-first across EVERY subject the key carries) ──────────────
  if (policy) {
    // Evaluate the request under each of the key's subjects (scope × app × team × cost-center).
    // Deny-first: the FIRST subject that denies (an explicit model deny or a rejecting constraint)
    // blocks the whole request — so a deny on ANY scope/app is honored, not just scopes[0]. Request
    // constraints are subject-independent, so any allowing subject's clamps are representative.
    let denied: PolicyDecision | undefined;
    let clampDecision: PolicyDecision | undefined;
    for (const subject of subjectsFromKey(key)) {
      const decision = evaluate({ subject, canonicalModelId: model, params }, policy);
      if (decision.outcome === "deny") {
        denied = decision;
        break;
      }
      if (decision.outcome === "clamp") clampDecision = decision;
    }
    if (denied) {
      // Carry the evaluator's own code (POLICY_MODEL_DENIED, or POLICY_PARAM_REJECTED for a
      // rejecting constraint) so the status map and terminal event report the real reason.
      const code = denied.reasonCodes[0] ?? "POLICY_MODEL_DENIED";
      return { ok: false, code, message: `request denied by policy (${code})` };
    }
    if (clampDecision?.clamps && parsed) {
      // Rewrite the clamped params back into the forwarded body — the provider sees the safe values.
      for (const [param, value] of Object.entries(clampDecision.clamps)) parsed[param] = value;
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
    const price = snapshot.offerings?.[target.offeringId]?.price;
    // Fail CLOSED when a µ$ (cost_microusd) hard budget rides an offering with NO known price
    // (review #4): the reserve estimate AND the committed actual would both be ~$0, letting unbounded
    // spend slip under the cap. A token-unit budget caps tokens (not µ$) and needs no price, so scope
    // the guard to cost_microusd budgets — token budgets over unpriced offerings still enforce.
    const budgetUnit = budget?.unit ?? "cost_microusd";
    const priceKnown =
      !!price &&
      (priceMtok(price.inputPerMtokMicroUsd) > 0n || priceMtok(price.outputPerMtokMicroUsd) > 0n);
    if (budgetUnit === "cost_microusd" && !priceKnown) {
      return {
        ok: false,
        code: "BUDGET_PRICE_UNKNOWN",
        message: "hard cost budget over an offering with no known price",
      };
    }
    // Token estimate so a unit=tokens hard budget guards on reserved_tokens BEFORE dispatch (#3): the
    // requested output ceiling + the ~4-chars/token input proxy. µ$ budgets ignore these; token
    // budgets (exempt from the price check above) rely on them to deny an over-cap request pre-dispatch.
    const maxOutputTokens = BigInt(
      Math.max(0, Math.ceil(params.max_tokens ?? params.max_output_tokens ?? 0)),
    );
    const reservation = await reserveBudget({
      budgetAccountId: budgetAccountId!,
      requestId: traceId,
      estMicroUsd: reservedEstimateMicroUsd(rawBody, params, price),
      estimatedInputTokens: estimateInputTokens(rawBody),
      maxOutputTokens,
    });
    if (!reservation.ok) {
      return { ok: false, code: "BUDGET_RESERVE_DENIED", message: "budget cap exceeded" };
    }
    // Carry the reservation id out so the terminal event can reconcile reserved→committed with the
    // ACTUAL cost once usage is known (§8.4). Without this the hold is only ever released by the
    // expiry sweep and real spend is never committed.
    reservationId = reservation.reservationId;
  }

  return { ok: true, forwardBody, reservationId };
}
