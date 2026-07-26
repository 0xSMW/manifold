import assert from "node:assert/strict";
import { test } from "node:test";
import type { HotPathObservationEvent } from "@manifold/ports";
import { DurableIngestSink, type ObservationIngestEnqueuer } from "../src/durableIngest.ts";
import type { EnqueueObservationIngestInput, EnqueueResult } from "../src/jobLedger.ts";

function event(kind: HotPathObservationEvent["kind"], seq: number, traceId = "trace_1"): HotPathObservationEvent {
  return {
    traceId,
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

class FakeLedger implements ObservationIngestEnqueuer {
  readonly inputs: EnqueueObservationIngestInput[] = [];
  failure?: Error;

  async enqueueObservationIngest(input: EnqueueObservationIngestInput): Promise<EnqueueResult> {
    if (this.failure) throw this.failure;
    this.inputs.push(input);
    return { id: "job_1", enqueued: true };
  }
}

function sink(ledger = new FakeLedger(), schedule?: () => void | Promise<void>) {
  return { ledger, sink: new DurableIngestSink({ workspaceId: "ws_1", producerId: "gateway_1", ledger, schedule }) };
}

test("collects one complete trace and enqueues an idempotent payload on terminal", async () => {
  const { sink: ingest, ledger } = sink();
  await ingest.emit(event("accepted", 0));
  await ingest.emit(event("provider_attempt", 1));
  await ingest.emit(event("terminal", 2));

  assert.deepEqual(ledger.inputs, [{
    version: 1,
    workspaceId: "ws_1",
    producerId: "gateway_1",
    events: [event("accepted", 0), event("provider_attempt", 1), event("terminal", 2)],
    idempotencyKey: "workspace:ws_1:trace:trace_1",
  }]);
});

test("allows a terminal-only trace for a pre-dispatch rejection", async () => {
  const { sink: ingest, ledger } = sink();
  await ingest.emit(event("terminal", 0));
  assert.equal(ledger.inputs[0]?.events.length, 1);
});

test("rejects a trace id mixed into a request-scoped sink", async () => {
  const { sink: ingest, ledger } = sink();
  await ingest.emit(event("accepted", 0));
  await assert.rejects(ingest.emit(event("provider_attempt", 1, "trace_2")), /mix observation trace ids/);
  assert.equal(ledger.inputs.length, 0);
});

test("rejects duplicate sequences", async () => {
  const { sink: ingest } = sink();
  await ingest.emit(event("accepted", 0));
  await assert.rejects(ingest.emit(event("provider_attempt", 0)), /strictly increasing/);
});

test("rejects an event after terminal", async () => {
  const { sink: ingest } = sink();
  await ingest.emit(event("accepted", 0));
  await ingest.emit(event("terminal", 1));
  await assert.rejects(ingest.emit(event("provider_attempt", 2)), /after terminal/);
});

test("propagates durable enqueue failure from terminal", async () => {
  const ledger = new FakeLedger();
  ledger.failure = new Error("ledger unavailable");
  const { sink: ingest } = sink(ledger);
  await ingest.emit(event("accepted", 0));
  await assert.rejects(ingest.emit(event("terminal", 1)), /ledger unavailable/);
});

test("schedules only after a durable enqueue and ignores schedule failure", async () => {
  const ledger = new FakeLedger();
  const order: string[] = [];
  const original = ledger.enqueueObservationIngest.bind(ledger);
  ledger.enqueueObservationIngest = async (input) => {
    order.push("enqueue");
    return original(input);
  };
  const { sink: ingest } = sink(ledger, async () => {
    order.push("schedule");
    throw new Error("scheduler unavailable");
  });
  await ingest.emit(event("accepted", 0));
  await ingest.emit(event("terminal", 1));
  assert.deepEqual(order, ["enqueue", "schedule"]);
});
