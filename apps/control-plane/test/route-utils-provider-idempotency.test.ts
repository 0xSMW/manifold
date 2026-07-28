import assert from "node:assert/strict";
import test from "node:test";
import { parseRevision } from "../app/api/v1/routes/[id]/route-utils.ts";

const target = {
  clientRef: "primary",
  providerCredentialId: "cred_a",
  offeringId: "offering_a",
};

test("route revision retains a request-local provider idempotency binding until the server generates target ids", () => {
  const input = parseRevision({
    targets: [target],
    retryPolicy: {
      maxAttempts: 2,
      providerIdempotency: { targetRef: "primary", headerName: "idempotency-key" },
    },
  });
  assert.deepEqual(input.retryPolicy, {
    max_attempts: 2,
    retry_on: [],
    backoff_ms: 0,
  });
  assert.deepEqual(input.providerIdempotency, { targetRef: "primary", headerName: "idempotency-key" });
  assert.equal(input.targets[0]?.clientRef, "primary");
});

test("route revision rejects an idempotency contract without an exact target", () => {
  assert.throws(() => parseRevision({
    targets: [target],
    retryPolicy: { providerIdempotency: { targetRef: "other", headerName: "idempotency-key" } },
  }), /must name a target clientRef/);
  assert.throws(() => parseRevision({
    targets: [target],
    retryPolicy: { providerIdempotency: { targetRef: "primary", headerName: "Idempotency-Key" } },
  }), /must be 'idempotency-key'/);
  assert.throws(() => parseRevision({
    targets: [target],
    retryPolicy: { providerIdempotency: { targetRef: "primary", headerName: "idempotency-key", extra: true } },
  }), /unknown field/);
});
