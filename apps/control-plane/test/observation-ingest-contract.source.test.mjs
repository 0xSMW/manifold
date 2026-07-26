import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../app/api/v1/observation-events:batch/route.ts", import.meta.url), "utf8");

test("observation ingest route validates the shared batch request and accepted response at the HTTP boundary", () => {
  assert.match(route, /contractValue\(body, ObservationIngestContracts\.batch\)/);
  assert.match(route, /contractOk\(ObservationIngestContracts\.accepted, result, requestId, 202\)/);
  assert.match(route, /jsonBody\(req\)/);
  assert.doesNotMatch(route, /\bok\(result/);
});
