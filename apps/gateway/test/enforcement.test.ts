// Adversarial enforcement tests (SPEC §11 policy + §16.3 hard budget, review bug #9).
//
// PROVES the deny paths NEVER dispatch: a policy-denied model and an over-cap hard budget must be
// rejected BEFORE the provider is called. Each test injects a counting fetcher and asserts the
// upstream call count — the load-bearing property is "0 upstream calls on a deny". These FAIL on
// the pre-fix code where handleRequest skips enforcement and dispatches everything.
//
// Spends ZERO external tokens: an in-memory counting fetcher + the in-memory FakeBudgetReserver
// stand in for the provider and the budget transaction. Run: `node --test test/*.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayContext } from "@manifold/gateway-core";
import { handleRequest } from "@manifold/gateway-core";
import type {
  Fetcher,
  Snapshot,
  SnapshotBudgetAccount,
  SnapshotPolicyRevision,
  SnapshotTarget,
} from "@manifold/ports";
import {
  capReserver,
  FakeCrypto,
  FakeIngestSink,
  FixedClock,
  keyedHashHex,
} from "@manifold/ports/testing";

// ── shared fixtures ──────────────────────────────────────────────────────────
const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("test-pepper");
const VALID_KEY = "sk-test-valid-key";
const keyHash = await keyedHashHex(crypto, pepper, VALID_KEY);

/** Counting Fetcher: records how many upstream calls happened + the body that was forwarded. */
class CountingFetcher implements Fetcher {
  count = 0;
  lastBodyText: string | null = null;
  async fetch(req: Request): Promise<Response> {
    this.count += 1;
    this.lastBodyText = req.body ? await req.text() : "";
    return new Response("upstream-ok", { status: 200 });
  }
}

function makeTarget(): SnapshotTarget {
  return {
    offeringId: "anthropic.messages",
    credentialId: "cred1",
    dekId: "dek1",
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: 0,
    baseUrl: "https://api.anthropic.com", // public + allowlisted ⇒ passes strict SSRF
    region: null,
    allowedHosts: ["api.anthropic.com"],
    authInject: { headers: { "x-api-key": "${secret}" } },
    secretEnv: null,
  };
}

interface SnapCfg {
  policy?: SnapshotPolicyRevision;
  budgetAccountId?: string;
  budgets?: Record<string, SnapshotBudgetAccount>;
}

function makeSnapshot(cfg: SnapCfg = {}): Snapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "test",
      revision: "r1",
      contentHash: "sha256:test",
      builtAt: "2026-07-20T00:00:00.000Z",
      signature: "",
      signingKeyId: "d",
    },
    profiles: {
      localhost: {
        id: "public_app",
        mode: "public_app",
        policyRevision: cfg.policy ? "pol1" : null,
        defaultRouteSet: null,
      },
    },
    keys: {
      [keyHash]: {
        id: "vk_test",
        profileId: "public_app",
        scopes: [],
        allowedAppIds: [],
        budgetAccountId: cfg.budgetAccountId ?? null,
        expiresAt: null,
      },
    },
    routes: {
      "public_app:/v1/messages": {
        routeId: "rt_messages",
        revision: "r1",
        mode: "ordered",
        timeoutMs: 5000,
        capturePolicyId: "cap_none",
        targets: [makeTarget()],
      },
    },
    // The target's offering, PRICED (review #4: a µ$ hard budget over an unpriced offering fails
    // closed). 1,000,000 µ$/mtok = 1 µ$/token, so the reserve estimate stays est ≈ max_tokens and the
    // capReserver comparisons (100 vs 1e6, generous 1e6) are unchanged.
    offerings: {
      "anthropic.messages": {
        priceRevisionId: "pr1",
        price: { inputPerMtokMicroUsd: "1000000", outputPerMtokMicroUsd: "1000000" },
      },
    },
    ...(cfg.policy ? { policies: { pol1: cfg.policy } } : {}),
    ...(cfg.budgets ? { budgets: cfg.budgets } : {}),
  };
}

function makeCtx(
  snapshot: Snapshot,
  fetcher: Fetcher,
  reserveBudget?: GatewayContext["reserveBudget"],
): GatewayContext {
  return {
    installationId: "test",
    snapshot,
    crypto,
    clock: new FixedClock(),
    ingest: new FakeIngestSink(),
    fetcher,
    pepper,
    resolveSecret: async () => "PROVIDER-SECRET",
    reserveBudget,
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { host: "localhost", authorization: `Bearer ${VALID_KEY}` },
    body: JSON.stringify(body),
  });
}

// A policy that allows every model EXCEPT an explicit deny on "blocked-model".
const ALLOW_ALL_BUT_BLOCKED: SnapshotPolicyRevision = {
  modelEntitlements: [
    { subjectKind: "all", subjectRef: null, canonicalModelId: null, effect: "allow" },
    { subjectKind: "all", subjectRef: null, canonicalModelId: "blocked-model", effect: "deny" },
  ],
  requestConstraints: [],
};

// ── (1) policy DENIES the model ⇒ 403 POLICY_MODEL_DENIED, upstream NEVER called ──
test("(1) policy-denied model ⇒ 403 POLICY_MODEL_DENIED and upstream call count 0", async () => {
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(makeSnapshot({ policy: ALLOW_ALL_BUT_BLOCKED }), fetcher);

  const res = await handleRequest(ctx, req({ model: "blocked-model", max_tokens: 10 }));

  assert.equal(res.status, 403, "denied model returns 403");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "POLICY_MODEL_DENIED");
  assert.equal(fetcher.count, 0, "provider was NEVER dispatched to");
});

// ── (2) allowed model but hard budget OVER CAP ⇒ BUDGET_RESERVE_DENIED, count 0 ──
test("(2) hard budget over cap ⇒ BUDGET_RESERVE_DENIED and upstream call count 0", async () => {
  const fetcher = new CountingFetcher();
  const reserver = capReserver(100n); // allow iff estMicroUsd ≤ 100
  const snapshot = makeSnapshot({
    policy: ALLOW_ALL_BUT_BLOCKED,
    budgetAccountId: "acct1",
    budgets: { acct1: { id: "acct1", enforcement: "hard" } },
  });
  const ctx = makeCtx(snapshot, fetcher, reserver.reserve.bind(reserver));

  // est ≈ max_tokens = 1_000_000 ≫ cap 100 ⇒ reserve denies.
  const res = await handleRequest(ctx, req({ model: "good-model", max_tokens: 1_000_000 }));

  assert.equal(res.status, 402, "over-cap hard budget returns 402");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "BUDGET_RESERVE_DENIED");
  assert.equal(reserver.calls.length, 1, "a reservation was attempted");
  assert.equal(fetcher.count, 0, "provider was NEVER dispatched to");
});

// ── (3) param over a CLAMP ceiling ⇒ dispatched with the CLAMPED value forwarded ──
test("(3) param over clamp ceiling ⇒ dispatched and forwarded body shows the clamped value", async () => {
  const fetcher = new CountingFetcher();
  const policy: SnapshotPolicyRevision = {
    modelEntitlements: [
      { subjectKind: "all", subjectRef: null, canonicalModelId: null, effect: "allow" },
    ],
    requestConstraints: [
      { param: "max_tokens", maxValue: 100, minValue: null, onViolation: "clamp" },
    ],
  };
  const ctx = makeCtx(makeSnapshot({ policy }), fetcher);

  const res = await handleRequest(ctx, req({ model: "good-model", max_tokens: 5000 }));

  assert.equal(res.status, 200, "a clamp does NOT deny — the request proceeds");
  assert.equal(fetcher.count, 1, "provider WAS dispatched to");
  const forwarded = JSON.parse(fetcher.lastBodyText ?? "{}") as { max_tokens: number };
  assert.equal(forwarded.max_tokens, 100, "forwarded body carries the CLAMPED max_tokens (100, not 5000)");
});

// ── (4) allow + under budget ⇒ dispatched (reservation made, upstream call count 1) ──
test("(4) allow + under budget ⇒ dispatched (upstream call count 1, reservation made)", async () => {
  const fetcher = new CountingFetcher();
  const reserver = capReserver(1_000_000n); // generous cap ⇒ allow
  const snapshot = makeSnapshot({
    policy: ALLOW_ALL_BUT_BLOCKED,
    budgetAccountId: "acct1",
    budgets: { acct1: { id: "acct1", enforcement: "hard" } },
  });
  const ctx = makeCtx(snapshot, fetcher, reserver.reserve.bind(reserver));

  const res = await handleRequest(ctx, req({ model: "good-model", max_tokens: 10 }));

  assert.equal(res.status, 200, "allowed + under budget proceeds");
  assert.equal(reserver.calls.length, 1, "a reservation WAS made before dispatch");
  assert.equal(fetcher.count, 1, "provider dispatched exactly once");
});
