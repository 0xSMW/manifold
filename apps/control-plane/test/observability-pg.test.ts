// Real-Postgres query/export invariants for the observation read model.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { selectObservationRows, observationIngestLagSeconds } from "../app/api/v1/observations/_store.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-observability", poolSize: 8 });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_obs_a','obs-a','Observability A','local'), ('ws_obs_b','obs-b','Observability B','local');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, public_name, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, occurred_at, created_at)
    VALUES
      ('obs_a','ws_obs_a','trace-a','inst-a','public_app','only-a','openai','ok',11,22,3,4,55,100,'2026-07-25T09:00:00Z','2026-07-25T09:00:00Z'),
      ('obs_b','ws_obs_b','trace-b','inst-b','public_app','only-b','anthropic','error',101,202,30,40,505,900,'2026-07-25T09:01:00Z','2026-07-25T09:01:00Z');
    INSERT INTO projection_checkpoint (workspace_id, projection, lag_seconds) VALUES
      ('ws_obs_a','observation',17), ('ws_obs_a','trace_summary',42),
      ('ws_obs_b','observation',999), ('ws_obs_b','trace_summary',1000);
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

async function asApp<T>(workspaceId: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

const filters = {
  from: "2026-07-25T00:00:00.000Z", to: "2026-07-26T00:00:00.000Z", range: null,
  profile: null, route: null, model: null, provider: null, status: null, app: null, action: null,
  key: null, costCenter: null, minLatencyMs: null, errorsOnly: false, trace: null,
};

test("observation list query and export-shaped read cannot cross workspace boundaries", async () => {
  const rows = await asApp("ws_obs_a", (sql) => selectObservationRows(sql as never, "ws_obs_a", filters, null, 500));
  assert.deepEqual(rows.map((row) => row.id), ["obs_a"]);
  assert.equal(rows[0]?.trace_id, "trace-a");
  const attemptedForeignFilter = await asApp("ws_obs_a", (sql) => selectObservationRows(sql as never, "ws_obs_a", { ...filters, trace: "trace-b" }, null, 500));
  assert.equal(attemptedForeignFilter.length, 0, "filtering with another workspace's trace must not disclose it");
  const directRows = await asApp("ws_obs_a", (sql) => sql`SELECT id FROM observation ORDER BY id`);
  assert.deepEqual(directRows.map((row) => String((row as unknown as { id: string }).id)), ["obs_a"], "RLS also protects export's source relation");
});

test("ingest lag reports this workspace's slowest relevant checkpoint", async () => {
  const lag = await asApp("ws_obs_a", (sql) => observationIngestLagSeconds(sql as never, "ws_obs_a"));
  assert.equal(lag, 42);
  const noCheckpoint = await asApp("ws_obs_a", async (sql) => {
    await sql`DELETE FROM projection_checkpoint WHERE workspace_id='ws_obs_a'`;
    return observationIngestLagSeconds(sql as never, "ws_obs_a");
  });
  assert.equal(noCheckpoint, 0, "no relevant checkpoint is truthfully reported as zero measured lag");
});
