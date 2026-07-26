import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { selectLatencySummary } from "../app/api/v1/observations/_store.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-latency-summary", poolSize: 4 });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_latency','latency','Latency', 'local'), ('ws_other','other','Other', 'local');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, public_name, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, occurred_at, created_at)
    VALUES
      ('obs_10','ws_latency','trace-10','inst','public_app','chat','openai','ok',0,0,0,0,0,10,'2026-07-25T01:00:00Z','2026-07-25T01:00:00Z'),
      ('obs_20','ws_latency','trace-20','inst','public_app','chat','openai','ok',0,0,0,0,0,20,'2026-07-25T01:01:00Z','2026-07-25T01:01:00Z'),
      ('obs_30','ws_latency','trace-30','inst','public_app','chat','openai','ok',0,0,0,0,0,30,'2026-07-25T01:02:00Z','2026-07-25T01:02:00Z'),
      ('obs_100','ws_latency','trace-100','inst','public_app','chat','openai','ok',0,0,0,0,0,100,'2026-07-25T01:03:00Z','2026-07-25T01:03:00Z'),
      ('obs_none','ws_latency','trace-none','inst','public_app','chat','openai','ok',0,0,0,0,0,NULL,'2026-07-25T01:04:00Z','2026-07-25T01:04:00Z'),
      ('obs_enterprise','ws_latency','trace-enterprise','inst','enterprise_egress','chat','openai','ok',0,0,0,0,0,900,'2026-07-25T01:05:00Z','2026-07-25T01:05:00Z'),
      ('obs_other','ws_other','trace-other','inst','public_app','chat','openai','ok',0,0,0,0,0,9999,'2026-07-25T01:06:00Z','2026-07-25T01:06:00Z');
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

async function asApp<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    await tx`SELECT set_config('manifold.workspace_id', 'ws_latency', true)`;
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

test("latency summary returns exact P50/P95 for the selected range and profile", async () => {
  const summary = await asApp((sql) => selectLatencySummary(sql as never, "ws_latency", "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z", "public_app"));
  assert.deepEqual(summary, { sampleCount: "4", p50Ms: 20, p95Ms: 100 });
});

test("latency summary has truthful unavailable values when the selection has no latency", async () => {
  const summary = await asApp((sql) => selectLatencySummary(sql as never, "ws_latency", "2026-07-26T00:00:00Z", "2026-07-27T00:00:00Z", "public_app"));
  assert.deepEqual(summary, { sampleCount: "0", p50Ms: null, p95Ms: null });
});
