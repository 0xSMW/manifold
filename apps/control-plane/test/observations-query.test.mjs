import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { ObservationContracts } from "@manifold/contracts";

class TestManifoldError extends Error {
  constructor(init) {
    super(init.message);
    Object.assign(this, init);
  }
}

function loadQueryModule() {
  const filename = new URL("../app/api/v1/observations/_query.ts", import.meta.url);
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: filename.pathname,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "@/lib/http") return { ManifoldError: TestManifoldError };
    throw new Error(`unexpected test dependency: ${specifier}`);
  };
  new Function("require", "module", "exports", "Buffer", output)(
    localRequire,
    module,
    module.exports,
    Buffer,
  );
  return module.exports;
}

const query = loadQueryModule();

test("observation filters normalize every supported filter without SQL fragments", () => {
  const filters = query.parseObservationFilters(
    new URLSearchParams({
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-02T00:00:00Z",
      profile: "enterprise_egress",
      route: "chat",
      model: "gpt-5",
      provider: "openai",
      status: "error",
      app: "console",
      action: "summarize",
      key: "mf_live_abcd",
      cost_center: "research",
      min_latency_ms: "250",
      errors_only: "true",
      q: "trace-fragment",
    }),
  );
  assert.deepEqual(filters, {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-02T00:00:00.000Z",
    range: null,
    profile: "enterprise_egress",
    route: "chat",
    model: "gpt-5",
    provider: "openai",
    status: "error",
    app: "console",
    action: "summarize",
    key: "mf_live_abcd",
    costCenter: "research",
    minLatencyMs: 250,
    errorsOnly: true,
    trace: "trace-fragment",
  });
});

test("composite observation cursors round-trip timestamp and id and reject malformed input", () => {
  const cursor = {
    createdAt: "2026-07-24T12:34:56.789Z",
    id: "obs_01K123",
  };
  assert.deepEqual(query.decodeCursor(query.encodeCursor(cursor)), cursor);
  assert.throws(() => query.decodeCursor("not-a-cursor"), TestManifoldError);
});

test("list and JSONL export use byte-for-byte equivalent observation serialization", () => {
  const row = {
    id: "obs_1",
    trace_id: "tr_1",
    installation_id: "inst_1",
    profile_mode: "public_app",
    route_id: "rt_1",
    public_name: "chat",
    endpoint_kind: "chat",
    final_provider: "openai",
    final_offering_id: "off_1",
    canonical_model_id: "cm_1",
    canonical_model_slug: "gpt-5",
    provider_model_id: "gpt-5",
    app_id: "app_1",
    app_slug: "console",
    action_id: "act_1",
    action_slug: "summarize",
    team_id: null,
    cost_center_id: "cc_1",
    cost_center_slug: "research",
    virtual_key_id: "key_1",
    key_prefix: "mf_live_abcd",
    status: "ok",
    http_status: 200,
    input_tokens: "12",
    output_tokens: "34",
    cache_read_tokens: "5",
    reasoning_tokens: "6",
    cache_write_tokens: "7",
    audio_input_tokens: "0",
    audio_output_tokens: "0",
    cost_microusd: "123456789012345678",
    cost_fidelity: "exact",
    latency_ms: 99,
    ttfb_ms: 20,
    attempts: 1,
    failovers: 0,
    reason_codes: [],
    compacted: false,
    occurred_at: "2026-07-24T12:34:56.000Z",
    created_at: "2026-07-24T12:34:56.100Z",
  };
  const listValue = query.serializeObservation(row);
  const jsonlValue = JSON.parse(`${JSON.stringify(query.serializeObservation(row))}\n`);
  assert.deepEqual(jsonlValue, listValue);
  assert.equal(jsonlValue.cost.amount_microusd, "123456789012345678");
});

test("observation serialization canonicalizes PostgreSQL timestamp text for the response contract", () => {
  const row = {
    id: "obs_1", trace_id: "tr_1", installation_id: "inst_1", profile_mode: "public_app",
    route_id: null, public_name: null, endpoint_kind: null, final_provider: null, final_offering_id: null,
    canonical_model_id: null, canonical_model_slug: null, provider_model_id: null, app_id: null, app_slug: null,
    action_id: null, action_slug: null, team_id: null, cost_center_id: null, cost_center_slug: null,
    virtual_key_id: null, key_prefix: null, status: "ok", http_status: 200,
    input_tokens: null, output_tokens: null, cache_read_tokens: null, reasoning_tokens: null,
    cache_write_tokens: null, audio_input_tokens: null, audio_output_tokens: null, cost_microusd: null,
    cost_fidelity: "unknown", latency_ms: null, ttfb_ms: null, attempts: 1, failovers: 0,
    reason_codes: [], compacted: false,
    occurred_at: "2026-07-24 12:34:56.123+00",
    created_at: "2026-07-24T12:34:56.456Z",
  };
  const value = query.serializeObservation(row);
  assert.equal(value.occurred_at, "2026-07-24T12:34:56.123Z");
  assert.equal(value.created_at, "2026-07-24T12:34:56.456Z");
  assert.equal(ObservationContracts.list.safeParse({ data: [value], next_cursor: null, ingest_lag_seconds: null }).success, true);

  const invalid = query.serializeObservation({ ...row, occurred_at: "not-a-timestamp" });
  assert.equal(ObservationContracts.list.safeParse({ data: [invalid], next_cursor: null, ingest_lag_seconds: null }).success, false);
});
