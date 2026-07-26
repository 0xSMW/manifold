import assert from "node:assert/strict";
import test from "node:test";
import { journalFromPortsEvent } from "../src/mapPortsEvent.js";

test("terminal capture crosses the flat gateway event into the journal without affecting reduction fields", () => {
  const event = journalFromPortsEvent({
    traceId: "trace_capture_map", kind: "terminal", seq: 1, occurredAt: "2026-07-25T00:00:00.000Z",
    profileId: "profile", keyId: null, routeId: "route", offeringId: "offering", status: 200, reasonCodes: [],
    capture: { mode: "full", bytes: 29, request: { prompt: "hello" }, response: { answer: "ok" } },
  } as never, { workspaceId: "workspace", producerId: "installation" });
  assert.equal(event.kind, "terminal");
  assert.deepEqual(event.payload.capture, { mode: "full", bytes: 29, request: { prompt: "hello" }, response: { answer: "ok" } });
});
