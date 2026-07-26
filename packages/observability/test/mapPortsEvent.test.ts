// packages/observability/test/mapPortsEvent.test.ts — regression tests for the ports → journal
// event mapper (#113). Two bugs under test:
//
//  1) costFidelity must be 'exact' ONLY when every billed (positive-count) token class has a
//     matching price; a partially-priced usage record must downgrade (never masquerade as exact,
//     since that would make an under-count of cost look authoritative — §6.10).
//  2) The terminal journal event must carry the HotPath reasonCodes (POLICY_*/AUTH_*/SSRF_*/etc.)
//     through into the payload, not just consume them internally to derive `status` — otherwise
//     the reduced Observation loses the denial cause entirely (§6.8).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HotPathObservationEvent } from "@manifold/ports";
import { journalFromPortsEvent } from "../src/mapPortsEvent.js";
import type { TerminalEvent } from "../src/events.js";

const CTX = { workspaceId: "ws_1", producerId: "prod_1" };

function terminalEvent(overrides: Partial<HotPathObservationEvent>): HotPathObservationEvent {
  return {
    traceId: "trace_1",
    kind: "terminal",
    seq: 1,
    occurredAt: "2026-07-21T00:00:00.000Z",
    profileId: "profile_1",
    keyId: null,
    routeId: null,
    offeringId: "offer_1",
    status: 200,
    reasonCodes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// (1) costFidelity: partial price coverage must not read as 'exact'.
// ---------------------------------------------------------------------------------------------

test("(1) costFidelity is 'exact' when every billed token class has a price", () => {
  const e = terminalEvent({
    usage: { inputTokens: 1_000, outputTokens: 500 },
    price: { inputPerMtokMicroUsd: "3000000", outputPerMtokMicroUsd: "15000000" },
  });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.equal(journal.payload.costFidelity, "exact");
});

test("(1) costFidelity is NOT 'exact' when a billed class (outputTokens) has no matching price", () => {
  // Usage has both input and output tokens, but the price snapshot only prices input — the
  // buggy version treated "any usage + any price" as sufficient for 'exact', silently
  // under-counting the output-token cost while claiming full fidelity.
  const e = terminalEvent({
    usage: { inputTokens: 1_000, outputTokens: 500 },
    price: { inputPerMtokMicroUsd: "3000000" }, // outputPerMtokMicroUsd MISSING
  });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.notEqual(journal.payload.costFidelity, "exact");
  assert.equal(journal.payload.costFidelity, "estimated");
});

test("(1) costFidelity is 'unknown' when there is usage but no price at all", () => {
  const e = terminalEvent({
    usage: { inputTokens: 1_000, outputTokens: 500 },
  });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.equal(journal.payload.costFidelity, "unknown");
});

test("(1) a zero-count token class does not need a price to stay 'exact'", () => {
  // inputTokens is present but zero; only outputTokens is actually billed, and it IS priced.
  const e = terminalEvent({
    usage: { inputTokens: 0, outputTokens: 500 },
    price: { outputPerMtokMicroUsd: "15000000" },
  });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.equal(journal.payload.costFidelity, "exact");
});

test("(1) an explicit conservative fallback remains estimated even with complete prices", () => {
  const e = terminalEvent({
    usage: { inputTokens: 1_000, outputTokens: 500 },
    price: { inputPerMtokMicroUsd: "3000000", outputPerMtokMicroUsd: "15000000" },
    costFidelity: "estimated",
  });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.equal(journal.payload.costFidelity, "estimated");
});

// ---------------------------------------------------------------------------------------------
// (2) terminal reasonCodes must survive into the journal payload, not just feed mapStatus().
// ---------------------------------------------------------------------------------------------

test("(2) terminal payload carries HotPath reasonCodes (POLICY_*) through, not just mapStatus", () => {
  const e = terminalEvent({
    status: 403,
    reasonCodes: ["POLICY_MODEL_DENIED"],
  });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.equal(journal.payload.status, "denied"); // mapStatus still derives the coarse status
  assert.deepEqual(journal.payload.reasonCodes, ["POLICY_MODEL_DENIED"]); // AND the cause survives
});

test("(2) terminal payload carries SSRF_BLOCKED through", () => {
  const e = terminalEvent({
    status: 403,
    reasonCodes: ["SSRF_BLOCKED"],
  });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.deepEqual(journal.payload.reasonCodes, ["SSRF_BLOCKED"]);
});

test("(2) terminal payload omits reasonCodes entirely when none were reported", () => {
  const e = terminalEvent({ reasonCodes: [] });
  const journal = journalFromPortsEvent(e, CTX) as TerminalEvent;
  assert.equal(journal.payload.reasonCodes, undefined);
});
