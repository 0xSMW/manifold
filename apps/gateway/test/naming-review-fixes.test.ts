// Regression tests for naming-review correctness bugs P0-1, P0-2, P0-4 (+ reservationRequestId
// robustness for P0-1). Each asserts the FIXED behavior and FAILS on the pre-fix code:
//
//   P0-1 — the gateway mints a REAL ULID request id, so the hard-budget reserve decodes an accurate
//          created_at (≈ now) and lands in the correct monthly partition instead of throwing on a
//          `trace_<hex>` non-ULID.
//   P0-2 — the reserve estimate is a REAL token×price µ$ estimate from the offering price, NOT the
//          raw max_tokens placeholder.
//   P0-4 — a key carrying multiple scopes is enforced under ALL of them: a deny on the SECOND scope
//          denies the request (POLICY_MODEL_DENIED), where the pre-fix code only checked scopes[0].
//
// Spends ZERO external tokens: an in-memory counting fetcher + an in-memory capturing reserver.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayContext } from "@manifold/gateway-core";
import { handleRequest } from "@manifold/gateway-core";
import type {
  Fetcher,
  Snapshot,
  SnapshotBudgetAccount,
  SnapshotOffering,
  SnapshotKey,
  SnapshotPolicyRevision,
  SnapshotTarget,
} from "@manifold/ports";
import {
  FakeBudgetReserver,
  FakeCrypto,
  FakeIngestSink,
  FixedClock,
  keyedHashHex,
} from "@manifold/ports/testing";
import { bucketStart, ulidCreatedAt, ulidTimeMs } from "@manifold/budget";
import { reservationRequestId } from "../src/adapters.ts";

// ── shared fixtures ────────────────────────────────────────────────────────────
const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("naming-review-pepper");
const VALID_KEY = "sk-naming-review-key";
const keyHash = await keyedHashHex(crypto, pepper, VALID_KEY);
const OFFERING_ID = "anthropic.messages";

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
    offeringId: OFFERING_ID,
    credentialId: "cred1",
    dekId: "dek1",
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: 0,
    baseUrl: "https://api.anthropic.com",
    region: null,
    allowedHosts: ["api.anthropic.com"],
    authInject: { headers: { "x-api-key": "${secret}" } },
    secretEnv: null,
  };
}

interface SnapCfg {
  policy?: SnapshotPolicyRevision;
  scopes?: string[];
  allowedAppIds?: string[];
  budgetAccountId?: string;
  budgets?: Record<string, SnapshotBudgetAccount>;
  offerings?: Record<string, SnapshotOffering>;
}

function makeSnapshot(cfg: SnapCfg = {}): Snapshot {
  const key: SnapshotKey = {
    id: "vk_test",
    profileId: "public_app",
    scopes: cfg.scopes ?? [],
    allowedAppIds: cfg.allowedAppIds ?? [],
    budgetAccountId: cfg.budgetAccountId ?? null,
    expiresAt: null,
  };
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
    keys: { [keyHash]: key },
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
    ...(cfg.policy ? { policies: { pol1: cfg.policy } } : {}),
    ...(cfg.budgets ? { budgets: cfg.budgets } : {}),
    ...(cfg.offerings ? { offerings: cfg.offerings } : {}),
  };
}

function makeCtx(
  snapshot: Snapshot,
  fetcher: Fetcher,
  clock: FixedClock,
  reserveBudget?: GatewayContext["reserveBudget"],
): GatewayContext {
  return {
    installationId: "test",
    snapshot,
    crypto,
    clock,
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

// ── P0-1: the gateway-minted request id is a real ULID ⇒ created_at ≈ now, correct bucket ───────
test("(P0-1) reserve request id is a ULID: created_at decodes to ≈now and lands in the correct monthly partition", async () => {
  const clock = new FixedClock(); // 2026-07-20T00:00:00.000Z
  const fetcher = new CountingFetcher();
  const reserver = new FakeBudgetReserver(); // captures every reserve() call, always allows
  const snapshot = makeSnapshot({
    budgetAccountId: "acct1",
    budgets: { acct1: { id: "acct1", enforcement: "hard" } },
  });
  const ctx = makeCtx(snapshot, fetcher, clock, (i) => reserver.reserve(i));

  const res = await handleRequest(ctx, req({ model: "good-model", max_tokens: 10 }));
  assert.equal(res.status, 200, "under-cap request dispatches");

  const requestId = reserver.calls[0]!.requestId;
  // Pre-fix `trace_<hex>` is NOT a ULID: ulidTimeMs throws on it (invalid Crockford char '_').
  const decodedMs = ulidTimeMs(requestId); // must NOT throw
  assert.equal(decodedMs, clock.now().getTime(), "the ULID time prefix decodes back to `now`");

  const createdAt = ulidCreatedAt(requestId);
  assert.equal(
    bucketStart("monthly", createdAt).toISOString(),
    "2026-07-01T00:00:00.000Z",
    "the reservation lands in July's monthly partition, not a garbage bucket",
  );

  // The trace id surfaced to the client is the same 26-char ULID.
  const traceId = res.headers.get("x-trace-id");
  assert.equal(traceId, requestId, "x-trace-id is the ULID request id");
  assert.equal(traceId!.length, 26, "a ULID is 26 chars");
});

// ── P0-1 (adapter): reservationRequestId passes a real ULID through, synthesizes for non-ULIDs ──
test("(P0-1) reservationRequestId: ULID pass-through, non-ULID synthesized to now, overflow lookalike rejected", () => {
  const now = new Date("2026-07-20T12:34:56.000Z");

  // A real ULID minted for `now` passes straight through (uppercased) — full idempotency + linkage.
  const realUlid = handleRequestUlidFor(now.getTime());
  assert.equal(reservationRequestId(realUlid, now), realUlid.toUpperCase(), "real ULID passes through");

  // Today's `trace_<hex>` id is NOT a ULID ⇒ synthesized with time = now, still a valid ULID.
  const synth = reservationRequestId("trace_deadbeefdeadbeefdeadbeefdeadbeef", now);
  assert.notEqual(synth, "trace_deadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(ulidTimeMs(synth), now.getTime(), "synthesized ULID carries `now`");

  // A 26-char Crockford LOOKALIKE whose first char overflows the 48-bit timestamp ('Z…') must NOT
  // be trusted as a ULID — it is re-synthesized with a real `now` instead of a garbage created_at.
  const overflow = "Z".repeat(26);
  const fixed = reservationRequestId(overflow, now);
  assert.equal(ulidTimeMs(fixed), now.getTime(), "overflow lookalike is re-synthesized to `now`");
});

/** Mint a ULID with a given time prefix the same way gateway-core does, for the pass-through test. */
function handleRequestUlidFor(ms: number): string {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let n = Math.floor(ms);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[n % 32]! + time;
    n = Math.floor(n / 32);
  }
  return time + "0123456789ABCDEF"; // 16 deterministic Crockford random chars
}

// ── P0-2: the reserve estimate is token×price µ$, not raw max_tokens ─────────────────────────────
test("(P0-2) reserve estimate = input_est×input_price + max_out×output_price (µ$), not raw max_tokens", async () => {
  const clock = new FixedClock();
  const fetcher = new CountingFetcher();
  const reserver = new FakeBudgetReserver();
  const INPUT_PRICE = 2_000_000n; // µ$ per 1,000,000 tokens
  const OUTPUT_PRICE = 3_000_000n;
  const snapshot = makeSnapshot({
    budgetAccountId: "acct1",
    budgets: { acct1: { id: "acct1", enforcement: "hard" } },
    offerings: {
      [OFFERING_ID]: {
        priceRevisionId: "pr1",
        price: {
          inputPerMtokMicroUsd: INPUT_PRICE.toString(),
          outputPerMtokMicroUsd: OUTPUT_PRICE.toString(),
        },
      },
    },
  });
  const ctx = makeCtx(snapshot, fetcher, clock, (i) => reserver.reserve(i));

  const MAX_TOKENS = 100;
  const body = { model: "good-model", max_tokens: MAX_TOKENS };
  const rawBody = JSON.stringify(body);
  await handleRequest(ctx, req(body));

  // Expected: input estimate ≈ ceil(bodyLen/4) tokens at INPUT_PRICE; max_tokens at OUTPUT_PRICE.
  const inputEst = BigInt(Math.ceil(rawBody.length / 4));
  const expected =
    (inputEst * INPUT_PRICE) / 1_000_000n + (BigInt(MAX_TOKENS) * OUTPUT_PRICE) / 1_000_000n;

  const est = reserver.calls[0]!.estMicroUsd;
  assert.equal(est, expected, "reserved µ$ equals the token×price estimate");
  assert.notEqual(est, BigInt(MAX_TOKENS), "reserved µ$ is NOT the raw max_tokens placeholder");
});

// ── P0-4: a deny on the SECOND scope denies the request (multi-scope enforcement) ───────────────
test("(P0-4) key with two scopes, SECOND denied ⇒ 403 POLICY_MODEL_DENIED, upstream count 0", async () => {
  const clock = new FixedClock();
  const fetcher = new CountingFetcher();
  // Allow every subject/model, but explicitly DENY the model for key_scope 'scope-b' (the 2nd scope).
  const policy: SnapshotPolicyRevision = {
    modelEntitlements: [
      { subjectKind: "all", subjectRef: null, canonicalModelId: null, effect: "allow" },
      { subjectKind: "key_scope", subjectRef: "scope-b", canonicalModelId: "good-model", effect: "deny" },
    ],
    requestConstraints: [],
  };
  const snapshot = makeSnapshot({ policy, scopes: ["scope-a", "scope-b"] });
  const ctx = makeCtx(snapshot, fetcher, clock);

  const res = await handleRequest(ctx, req({ model: "good-model", max_tokens: 10 }));

  assert.equal(res.status, 403, "a deny on the second scope denies the request");
  const errBody = (await res.json()) as { error: { code: string } };
  assert.equal(errBody.error.code, "POLICY_MODEL_DENIED");
  assert.equal(fetcher.count, 0, "provider was NEVER dispatched to");
});

// ── P0-4 (guard): a key whose scopes are all permitted still proceeds (no over-denial regression) ─
test("(P0-4) key with two scopes, NEITHER denied ⇒ dispatched (allow-all is not over-denied)", async () => {
  const clock = new FixedClock();
  const fetcher = new CountingFetcher();
  const policy: SnapshotPolicyRevision = {
    modelEntitlements: [
      { subjectKind: "all", subjectRef: null, canonicalModelId: null, effect: "allow" },
      { subjectKind: "key_scope", subjectRef: "scope-b", canonicalModelId: "other-model", effect: "deny" },
    ],
    requestConstraints: [],
  };
  const snapshot = makeSnapshot({ policy, scopes: ["scope-a", "scope-b"] });
  const ctx = makeCtx(snapshot, fetcher, clock);

  const res = await handleRequest(ctx, req({ model: "good-model", max_tokens: 10 }));

  assert.equal(res.status, 200, "the deny is scoped to a different model ⇒ this request proceeds");
  assert.equal(fetcher.count, 1, "provider dispatched exactly once");
});
