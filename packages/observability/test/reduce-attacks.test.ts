// packages/observability/test/reduce-attacks.test.ts — adversarial tests for the reducer.
//
// SPEC §8.3, §6.8, §6.9, §16.6, ADR-0011. These are hostile, not confirmatory: they attack
// the reducer's core guarantees — order-independence, idempotent dedup, cost-only-from-bytes,
// replay determinism, and totality on a missing terminal. Assertions are intentionally strict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { project, reduce, type ObservationEvent } from "../src/index.js";

// ---------------------------------------------------------------------------------------------
// Fixtures. A realistic trace: accepted → attempt(A, fails, no bytes) → attempt(B, ok, tokens)
// → terminal(ok). Providers A→B is a failover; both attempts recorded; terminal is authoritative.
// ---------------------------------------------------------------------------------------------

const WS = "ws_1";
const TRACE = "trace_1";
const PRODUCER = "prod_1";

// Non-zero per-mtok µ$ prices, so "zero cost" can only come from zero tokens, never zero price.
const PRICE = {
  inputPerMtokMicroUsd: 3_000_000n, // $3.00 / 1M
  outputPerMtokMicroUsd: 15_000_000n, // $15.00 / 1M
} as const;

function richTrace(): ObservationEvent[] {
  return [
    {
      kind: "accepted",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_accepted",
      seq: 1,
      occurredAt: "2026-07-20T00:00:00.000Z",
      payload: { routeId: "route_1", appId: "app_1", teamId: "team_1" },
    },
    {
      kind: "provider_attempt",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_attempt_a",
      seq: 2,
      occurredAt: "2026-07-20T00:00:00.100Z",
      payload: {
        provider: "provider_a",
        outcome: "error",
        httpStatus: 503,
        reasonCodes: ["PROVIDER_HTTP_5XX", "FAILOVER_ATTEMPT"],
        // No tokens: this attempt produced no bytes.
      },
    },
    {
      kind: "provider_attempt",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_attempt_b",
      seq: 3,
      occurredAt: "2026-07-20T00:00:00.200Z",
      payload: {
        provider: "provider_b",
        offeringId: "offer_b",
        outcome: "ok",
        httpStatus: 200,
        tokens: { inputTokens: 1_000n, outputTokens: 500n },
      },
    },
    {
      kind: "terminal",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_terminal",
      seq: 4,
      occurredAt: "2026-07-20T00:00:00.300Z",
      payload: {
        status: "ok",
        httpStatus: 200,
        tokens: { inputTokens: 1_000n, outputTokens: 500n },
        price: PRICE,
        costFidelity: "exact",
        finalProvider: "provider_b",
        finalOfferingId: "offer_b",
        priceRevisionId: "price_rev_1",
        appId: "app_1",
        teamId: "team_1",
        budgetAccountId: "budget_1",
      },
    },
  ];
}

// A deterministic (seeded) permutation generator — pure, so the test itself is reproducible.
function seededShuffle<T>(input: readonly T[], seed: number): T[] {
  const arr = [...input];
  let s = seed >>> 0;
  const next = () => {
    // xorshift32 — deterministic PRNG, no float, no Math.random.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const a = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = a;
  }
  return arr;
}

// ---------------------------------------------------------------------------------------------
// (1) DETERMINISM / order-independence — §16.6, ADR-0011.
// ---------------------------------------------------------------------------------------------
test("(1) reduction is identical regardless of input event order", () => {
  const base = reduce(richTrace());

  // Baseline sanity so the equality below is meaningful (not two identical wrong answers).
  assert.equal(base.status, "ok");
  assert.equal(base.attempts, 2);
  assert.equal(base.failovers, 1);
  assert.deepEqual(base.tokens.inputTokens, 1_000n);
  assert.deepEqual(base.tokens.outputTokens, 500n);

  // Reverse order.
  assert.deepEqual(reduce([...richTrace()].reverse()), base);

  // 200 distinct seeded shuffles — every permutation must fold to the SAME Observation.
  for (let seed = 1; seed <= 200; seed++) {
    const shuffled = seededShuffle(richTrace(), seed);
    assert.deepEqual(reduce(shuffled), base, `shuffle seed=${seed} diverged`);
  }
});

// ---------------------------------------------------------------------------------------------
// (2) DEDUP — a duplicate event (same dedup anchor) does not double-count. §6.8, §8.3, INGEST_DEDUP.
// ---------------------------------------------------------------------------------------------
test("(2) duplicate events do not double-count tokens or attempts (INGEST_DEDUP)", () => {
  const base = reduce(richTrace());

  const events = richTrace();
  // Re-deliver the terminal AND a provider_attempt verbatim (same workspace/producer/idem key).
  const dupTerminal = events.find((e) => e.idempotencyKey === "idem_terminal")!;
  const dupAttempt = events.find((e) => e.idempotencyKey === "idem_attempt_b")!;
  const withDupes = [...events, structuredClone(dupTerminal), structuredClone(dupAttempt)];

  const reduced = reduce(withDupes);

  // Tokens are NOT doubled.
  assert.deepEqual(reduced.tokens, base.tokens);
  // Attempts are NOT doubled (still exactly the two distinct attempts).
  assert.equal(reduced.attempts, 2);
  assert.equal(reduced.failovers, 1);
  // The dedup is observable as INGEST_DEDUP.
  assert.ok(
    reduced.reasonCodes.includes("INGEST_DEDUP"),
    "expected INGEST_DEDUP reason code when a duplicate was dropped",
  );
  // Everything else is identical to the no-dupe reduction, aside from the added reason code.
  assert.deepEqual(
    { ...reduced, reasonCodes: reduced.reasonCodes.filter((c) => c !== "INGEST_DEDUP") },
    base,
  );

  // And the projected cost is unchanged (no double spend).
  assert.deepEqual(project(reduced).cost.amountMicroUsd, project(base).cost.amountMicroUsd);
});

// ---------------------------------------------------------------------------------------------
// (3) A retry that produced no bytes contributes a failover/attempt but ZERO cost. §6.10, §8.4.
// ---------------------------------------------------------------------------------------------
test("(3) no-byte retries add attempts/failovers but cost is exactly zero", () => {
  // Two providers, both fail with no bytes; the request terminates in error. Prices are non-zero.
  const events: ObservationEvent[] = [
    {
      kind: "accepted",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_accepted",
      seq: 1,
      occurredAt: "2026-07-20T00:00:00.000Z",
      payload: { routeId: "route_1" },
    },
    {
      kind: "provider_attempt",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_attempt_a",
      seq: 2,
      occurredAt: "2026-07-20T00:00:00.100Z",
      payload: { provider: "provider_a", outcome: "timeout", reasonCodes: ["PROVIDER_TIMEOUT"] },
    },
    {
      kind: "provider_attempt",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_attempt_b",
      seq: 3,
      occurredAt: "2026-07-20T00:00:00.200Z",
      payload: {
        provider: "provider_b",
        outcome: "timeout",
        reasonCodes: ["PROVIDER_TIMEOUT", "FAILOVER_ATTEMPT"],
      },
    },
    {
      kind: "terminal",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_terminal",
      seq: 4,
      occurredAt: "2026-07-20T00:00:00.300Z",
      // Terminal error, no tokens, but a real (non-zero) price is attached.
      payload: { status: "error", price: PRICE, costFidelity: "exact" },
    },
  ];

  const obs = reduce(events);
  assert.equal(obs.status, "error");
  assert.equal(obs.attempts, 2, "both no-byte attempts must be counted");
  assert.equal(obs.failovers, 1, "the A→B switch is a failover");

  const { usage, cost } = project(obs);
  // Zero tokens ⇒ zero cost, even though per-mtok prices are non-zero.
  assert.deepEqual(usage.tokens.inputTokens, 0n);
  assert.deepEqual(usage.tokens.outputTokens, 0n);
  assert.equal(cost.amountMicroUsd, 0n);
});

// ---------------------------------------------------------------------------------------------
// (4) Replay determinism — reduce(events) === reduce(events) across independent runs. ADR-0011.
// ---------------------------------------------------------------------------------------------
test("(4) replay is deterministic: reduce(events) === reduce(events)", () => {
  const a = reduce(richTrace());
  const b = reduce(richTrace());
  assert.deepEqual(a, b);
  // Projection is deterministic too.
  assert.deepEqual(project(a), project(b));
  // And stable under re-reduction of a fresh copy (idempotent replay).
  assert.deepEqual(reduce(structuredClone(richTrace())), a);
});

// ---------------------------------------------------------------------------------------------
// (5) Missing terminal ⇒ status reflects incomplete, not a crash. §16.6, ADR-0011.
// ---------------------------------------------------------------------------------------------
test("(5) a trace with no terminal event reduces to 'incomplete' without throwing", () => {
  const events: ObservationEvent[] = [
    {
      kind: "accepted",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_accepted",
      seq: 1,
      occurredAt: "2026-07-20T00:00:00.000Z",
      payload: { routeId: "route_1" },
    },
    {
      kind: "provider_attempt",
      workspaceId: WS,
      traceId: TRACE,
      producerId: PRODUCER,
      idempotencyKey: "idem_attempt_a",
      seq: 2,
      occurredAt: "2026-07-20T00:00:00.100Z",
      payload: { provider: "provider_a", outcome: "ok", tokens: { inputTokens: 10n } },
    },
    // No terminal event — the request never completed (or its terminal is still in flight).
  ];

  const obs = reduce(events); // must not throw
  assert.equal(obs.status, "incomplete");
  assert.equal(obs.complete, false);
  assert.equal(obs.attempts, 1);

  // Projection is still total and safe; no terminal ⇒ no authoritative tokens ⇒ zero cost.
  const { cost } = project(obs);
  assert.equal(cost.amountMicroUsd, 0n);

  // An empty event set is also total, not a crash.
  const empty = reduce([]);
  assert.equal(empty.status, "incomplete");
  assert.equal(empty.attempts, 0);
});
