import assert from "node:assert/strict";
import test from "node:test";
import { consumeStream, runFlatMemoryGate } from "../../tools/load/flat-memory-release.mjs";
import { runFlatMemoryFixtureGate } from "../../scripts/run-flat-memory-fixture.mjs";
test("flat-memory consumer reads streaming bytes without retaining the payload", async () => {
  let emitted = 0; const chunks = 128; const chunk = new Uint8Array(64 * 1024);
  const body = new ReadableStream({ pull(controller) { if (emitted === chunks) return controller.close(); emitted += 1; controller.enqueue(chunk); } });
  assert.equal(await consumeStream(body), chunks * chunk.byteLength);
});

test("external flat-memory gate requires an authentication credential", async () => {
  await assert.rejects(
    () => runFlatMemoryGate({
      MANIFOLD_FLAT_MEMORY_TARGET_URL: "https://gateway.example/stream",
      MANIFOLD_GATEWAY_MEMORY_PROBE_URL: "https://gateway.example/memory",
      MANIFOLD_GATEWAY_MEMORY_CONTRACT: "v1",
    }),
    /missing required environment: MANIFOLD_VIRTUAL_KEY/,
  );
});

test("local release gate measures the built gateway-core process and preserves exact bytes", async () => {
  const result = await runFlatMemoryFixtureGate({
    ...process.env,
    MANIFOLD_FLAT_MEMORY_BYTES: String(2 * 1024 * 1024),
    MANIFOLD_FLAT_MEMORY_MAX_RSS_DELTA_BYTES: String(128 * 1024 * 1024),
  });
  assert.equal(result.bytes, 2 * 1024 * 1024);
  assert.equal(result.gatewayCoreArtifact, "packages/gateway-core/dist/index.js");
  assert.ok(result.peakRss >= result.baselineRss);
});

test("local release gate fails when measured gateway RSS exceeds its bound", async () => {
  await assert.rejects(() => runFlatMemoryFixtureGate({
    ...process.env,
    MANIFOLD_FLAT_MEMORY_BYTES: String(2 * 1024 * 1024),
    MANIFOLD_FLAT_MEMORY_MAX_RSS_DELTA_BYTES: String(1024 * 1024),
    MANIFOLD_FLAT_MEMORY_FORCE_GROWTH_BYTES: String(16 * 1024 * 1024),
  }), /gateway RSS delta .* exceeds/);
});
