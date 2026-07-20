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
  secretEnv: null,
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
  revoked: false,
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
    snapshot: { budgets: { ba: { id: "ba", enforcement: "hard" } } } as unknown as Snapshot,
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
