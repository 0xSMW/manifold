import assert from "node:assert/strict";
import { test } from "node:test";
import type { HotPathObservationEvent } from "@manifold/ports";
import {
  jobBackoffMs,
  redactJobError,
  validateObservationIngestPayload,
} from "../src/jobLedger.ts";

function event(kind: HotPathObservationEvent["kind"], seq: number): HotPathObservationEvent {
  return {
    traceId: "01K0TRACE000000000000000000",
    kind,
    seq,
    occurredAt: "2026-07-24T00:00:00.000Z",
    profileId: "enterprise_egress",
    keyId: "key_1",
    routeId: "route_1",
    offeringId: "model_1",
    status: kind === "terminal" ? 200 : null,
    reasonCodes: [],
  };
}

test("job backoff is exponential, capped, and accepts deterministic jitter", () => {
  assert.equal(jobBackoffMs(1, { baseDelayMs: 100, maxDelayMs: 1_000 }), 100);
  assert.equal(jobBackoffMs(4, { baseDelayMs: 100, maxDelayMs: 1_000 }), 800);
  assert.equal(jobBackoffMs(8, { baseDelayMs: 100, maxDelayMs: 1_000 }), 1_000);
  assert.equal(
    jobBackoffMs(2, { baseDelayMs: 100, maxDelayMs: 1_000, jitter: (_attempt, delay) => delay / 2 }),
    300,
  );
  assert.throws(() => jobBackoffMs(0), /positive integer/);
});

test("job error redaction removes DSNs and common secret forms", () => {
  const redacted = redactJobError(
    new Error("postgres://alice:password@db.example/app password=hunter2 apiKey: xyz authorization: Bearer abc123 sk-supersecret"),
  );
  assert.equal(redacted.code, "Error");
  assert.doesNotMatch(redacted.message, /alice|hunter2|xyz|abc123|supersecret|db\.example/);
  assert.match(redacted.message, /REDACTED/);
});

test("observation payload requires one complete trace and a terminal event", () => {
  const payload = validateObservationIngestPayload({
    version: 1,
    workspaceId: "ws_1",
    producerId: "gateway_1",
    events: [event("accepted", 0), event("terminal", 1)],
  });
  assert.equal(payload.events.length, 2);

  assert.throws(
    () => validateObservationIngestPayload({ ...payload, events: [event("accepted", 0)] }),
    /terminal event/,
  );
  assert.throws(
    () => validateObservationIngestPayload({ ...payload, events: [event("accepted", 0), event("terminal", 0)] }),
    /unique sequences/,
  );
  assert.throws(
    () => validateObservationIngestPayload({ ...payload, events: [event("terminal", 0), event("terminal", 1)] }),
    /exactly one terminal/,
  );
  assert.throws(
    () => validateObservationIngestPayload({ ...payload, workspaceId: "" }),
    /identity/,
  );
});
