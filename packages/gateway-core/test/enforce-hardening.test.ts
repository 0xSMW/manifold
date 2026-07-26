// Regression tests for the enforcement-gate hardening (review HIGH #5/#6, MED config-F7).
// enforceRequest is the gate between auth and dispatch; each case here MUST fail closed so a
// malformed/oversized/drifted request never reaches a provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BudgetReserver, Snapshot, SnapshotKey, SnapshotProfile, SnapshotTarget } from "@manifold/ports";
import { enforceRequest } from "../src/enforce.ts";

const target: SnapshotTarget = {
  offeringId: "off",
  credentialId: "c",
  dekId: "d",
  credentialCiphertext: "",
  wrappedDek: "",
  weight: 1,
  priority: 0,
  baseUrl: "https://api.example.com",
  region: null,
  allowedHosts: ["api.example.com"],
  authInject: { headers: {} },
};

const profile = (policyRevision: string | null): SnapshotProfile => ({
  id: "p",
  mode: "public_app",
  policyRevision,
  defaultRouteSet: null,
});

const key = (budgetAccountId: string | null): SnapshotKey => ({
  id: "k",
  profileId: "p",
  scopes: [],
  allowedAppIds: [],
  budgetAccountId,
  expiresAt: null,
});

const okReserve: BudgetReserver["reserve"] = async () => ({ ok: true, reservationId: "r" });

function req(body: string): Request {
  return new Request("http://x/v1/messages", { method: "POST", body });
}

// #5 — a profile that DECLARES a policy revision the signed snapshot doesn't carry must fail closed,
// not slip through the "nothing to enforce" fast path unfiltered.
test("HIGH #5: unresolved policy revision fails CLOSED (POLICY_MODEL_DENIED)", async () => {
  const res = await enforceRequest({
    snapshot: { policies: {} } as unknown as Snapshot,
    profile: profile("rev_that_is_missing"),
    key: key(null),
    request: req("{}"),
    traceId: "t",
    target,
  });
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "POLICY_MODEL_DENIED");
});

// control: no declared policy + no hard budget ⇒ fast path, body untouched, dispatch allowed.
test("control: no policy + no hard budget ⇒ fast-path allow", async () => {
  const res = await enforceRequest({
    snapshot: { policies: {} } as unknown as Snapshot,
    profile: profile(null),
    key: key(null),
    request: req("{}"),
    traceId: "t",
    target,
  });
  assert.equal(res.ok, true);
});

// #6 — an oversized body under active enforcement must be rejected (413) BEFORE it is buffered whole
// or reaches the reserve/dispatch path.
test("HIGH #6: oversized request body fails CLOSED (POLICY_BODY_TOO_LARGE)", async () => {
  const bigBody = "x".repeat(4 * 1024 * 1024 + 128); // just over the 4 MiB cap
  const res = await enforceRequest({
    snapshot: { budgets: { ba: { id: "ba", enforcement: "hard" } } } as unknown as Snapshot,
    profile: profile(null),
    key: key("ba"),
    request: req(bigBody),
    traceId: "t",
    target,
    reserveBudget: okReserve,
  });
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "POLICY_BODY_TOO_LARGE");
});

// config-F7 — a non-finite numeric param (JSON.parse turns 1e999 into Infinity) must be rejected, not
// silently dropped so a max_tokens ceiling is bypassed and the raw value forwarded.
test("config-F7: non-finite numeric param fails CLOSED (POLICY_PARAM_REJECTED)", async () => {
  const res = await enforceRequest({
    snapshot: { budgets: { ba: { id: "ba", enforcement: "hard", unit: "tokens" } } } as unknown as Snapshot,
    profile: profile(null),
    key: key("ba"),
    request: req('{"model":"m","max_tokens":1e999}'),
    traceId: "t",
    target,
    reserveBudget: okReserve,
  });
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "POLICY_PARAM_REJECTED");
});

// #4 — a µ$ (cost_microusd) HARD budget over an offering with NO known price must fail closed: a $0
// estimate + $0 committed would let unbounded spend slip under the cap (unlimited free spend).
test("#4: hard COST budget over an unpriced offering fails CLOSED (BUDGET_PRICE_UNKNOWN)", async () => {
  const res = await enforceRequest({
    snapshot: { budgets: { ba: { id: "ba", enforcement: "hard", unit: "cost_microusd" } } } as unknown as Snapshot,
    profile: profile(null),
    key: key("ba"),
    request: req('{"model":"m","max_tokens":10}'),
    traceId: "t",
    target, // no snapshot.offerings ⇒ price unknown
    reserveBudget: okReserve,
  });
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "BUDGET_PRICE_UNKNOWN");
});

// #4 control — a TOKEN-unit hard budget caps tokens, not µ$, so an unpriced offering still reserves.
test("#4 control: hard TOKEN budget over an unpriced offering still reserves (no price needed)", async () => {
  const res = await enforceRequest({
    snapshot: { budgets: { ba: { id: "ba", enforcement: "hard", unit: "tokens" } } } as unknown as Snapshot,
    profile: profile(null),
    key: key("ba"),
    request: req('{"model":"m","max_tokens":10}'),
    traceId: "t",
    target,
    reserveBudget: okReserve,
  });
  assert.equal(res.ok, true);
});

test("hard cost reservation covers the most expensive eligible failover target", async () => {
  const expensiveTarget = { ...target, offeringId: "off-expensive", credentialId: "c-expensive" };
  let estimate: bigint | undefined;
  const res = await enforceRequest({
    snapshot: {
      budgets: { ba: { id: "ba", enforcement: "hard", unit: "cost_microusd" } },
      offerings: {
        off: {
          price: {
            inputPerMtokMicroUsd: "0",
            outputPerMtokMicroUsd: "1000000",
          },
        },
        "off-expensive": {
          price: {
            inputPerMtokMicroUsd: "0",
            outputPerMtokMicroUsd: "3000000",
          },
        },
      },
    } as unknown as Snapshot,
    profile: profile(null),
    key: key("ba"),
    request: req('{"model":"m","max_tokens":10}'),
    traceId: "t",
    target,
    reservationTargets: [target, expensiveTarget],
    reserveBudget: async (input) => {
      estimate = input.estMicroUsd;
      return { ok: true, reservationId: "r" };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(estimate, 30n);
  if (res.ok) {
    assert.deepEqual(res.reservationFallback?.usage, { inputTokens: 8, outputTokens: 10 });
  }
});

// HIGH #1 — a STRING max_tokens ("1000000") must be visible to a policy clamp ceiling exactly like
// a JSON number. Pre-fix, `numericParams` only accepted `typeof v === "number"`, so the string value
// was silently dropped from `params`: no clamp constraint ever saw it (evaluated as "param absent"),
// and the reserve estimate's `params.max_tokens ?? ... ?? 0` fell back to 0 (maxOut=0) — a hard cap
// and a hard-budget reserve estimate both bypassed while the raw string was still forwarded upstream.
test("HIGH #1: STRING max_tokens over a clamp ceiling is clamped, not bypassed", async () => {
  const policy = {
    id: "rev1",
    modelEntitlements: [{ subjectKind: "all", subjectRef: null, canonicalModelId: null, effect: "allow" }],
    requestConstraints: [{ param: "max_tokens", maxValue: 4096, minValue: null, onViolation: "clamp" }],
  } as unknown as import("@manifold/ports").SnapshotPolicyRevision;

  const res = await enforceRequest({
    snapshot: { policies: { rev1: policy } } as unknown as Snapshot,
    profile: profile("rev1"),
    key: key(null),
    request: req('{"model":"m","max_tokens":"1000000"}'),
    traceId: "t",
    target,
  });
  assert.equal(res.ok, true);
  const forwardBody = (res as { forwardBody?: string }).forwardBody;
  assert.ok(forwardBody, "clamp must rewrite forwardBody");
  const forwarded = JSON.parse(forwardBody!);
  assert.equal(forwarded.max_tokens, 4096, "the string value must be clamped, not passed through raw");
});

// HIGH #1 (budget side) — a STRING max_tokens must also be visible to the hard-budget reserve
// estimate: pre-fix, `params.max_tokens` was `undefined` for a string value, so `maxOut` collapsed
// to 0 and a token-unit hard budget's `reserveBudget` was called with `maxOutputTokens: 0n`,
// defeating the pre-dispatch token guard entirely.
test("HIGH #1: STRING max_tokens reaches the hard-budget reserve estimate (maxOutputTokens != 0)", async () => {
  let seenMaxOutputTokens: bigint | undefined;
  const capturingReserve: BudgetReserver["reserve"] = async (req) => {
    seenMaxOutputTokens = req.maxOutputTokens;
    return { ok: true, reservationId: "r" };
  };
  const res = await enforceRequest({
    snapshot: { budgets: { ba: { id: "ba", enforcement: "hard", unit: "tokens" } } } as unknown as Snapshot,
    profile: profile(null),
    key: key("ba"),
    request: req('{"model":"m","max_tokens":"1000000"}'),
    traceId: "t",
    target,
    reserveBudget: capturingReserve,
  });
  assert.equal(res.ok, true);
  assert.equal(seenMaxOutputTokens, 1000000n);
});

// HIGH #2 — a key with a budgetAccountId that has NO matching `snapshot.budgets` entry must fail
// CLOSED, symmetric with the #5 "declared policy revision missing from snapshot" case. Pre-fix,
// `budget` was `undefined` ⇒ `hardBudget` was `false` ⇒ (absent a policy too) the request took the
// "nothing to enforce" fast path and dispatched completely unmetered.
test("HIGH #2: budgetAccountId with no matching snapshot.budgets entry fails CLOSED (BUDGET_RESERVE_DENIED)", async () => {
  const res = await enforceRequest({
    snapshot: { budgets: {} } as unknown as Snapshot, // "ba" is absent
    profile: profile(null),
    key: key("ba"),
    request: req("{}"),
    traceId: "t",
    target,
    reserveBudget: okReserve,
  });
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "BUDGET_RESERVE_DENIED");
});

// HIGH #2 control — a key with NO budgetAccountId at all (null) is unaffected and still fast-paths.
test("HIGH #2 control: key with no budgetAccountId (null) still fast-paths", async () => {
  const res = await enforceRequest({
    snapshot: { budgets: {} } as unknown as Snapshot,
    profile: profile(null),
    key: key(null),
    request: req("{}"),
    traceId: "t",
    target,
  });
  assert.equal(res.ok, true);
});
