// Real-Postgres proof that a compacted trace remains readable through the production detail seam.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PostgresStorageRepository } from "../../../packages/storage/src/postgres.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { compactedDetailView, loadCompactedTrace } from "../app/api/v1/observations/_compacted.ts";
import { ingestBatch } from "../lib/observation-ingest/index.ts";

let pg: PgHarness;
let repository: PostgresStorageRepository;

before(async () => {
  pg = await startPg({ namePrefix: "mf-compacted-trace", poolSize: 4 });
  process.env.DATABASE_URL = pg.url;
  repository = new PostgresStorageRepository(pg.sql as never);
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('ws_compacted','compacted','Compacted','local');
    SELECT create_month_partition('observation', DATE '2026-01-01');
    SELECT create_month_partition('observation_event', DATE '2026-01-01');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, status,
      input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens,
      audio_input_tokens, audio_output_tokens, cost_microusd, cost_fidelity, occurred_at, created_at)
    VALUES ('obs_compacted','ws_compacted','trace_compacted','inst','public_app','ok',
      101,202,3,4,5,6,7,123456,'unknown','2026-01-10T00:30:00Z','2026-01-10T00:30:00Z');
    INSERT INTO usage_record (id, workspace_id, observation_id, trace_id, input_tokens, output_tokens,
      cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
      fidelity, occurred_at, created_at)
    VALUES ('usage_compacted','ws_compacted','obs_compacted','trace_compacted',
      101,202,3,4,5,6,7,'exact','2026-01-10T00:30:00Z','2026-01-10T00:30:00Z');
    INSERT INTO observation_event (id, workspace_id, trace_id, span_id, installation_id, profile_mode,
      kind, seq, producer_id, idempotency_key, payload, occurred_at, created_at)
    VALUES ('event_compacted','ws_compacted','trace_compacted','span_compacted','inst','public_app',
      'terminal', 1, 'inst', 'trace_compacted:1', '{"status":"ok"}', '2026-01-10T00:30:00Z','2026-01-10T00:30:00Z');
    INSERT INTO storage_retention_setting (workspace_id, observation_retention_days, min_trace_days, export_target, export_location, enabled_at)
      VALUES ('ws_compacted', 30, 30, 'local_filesystem', '/tmp/manifold-compacted-trace-test', now());
  `);
  await repository.aggregateClosedHour("ws_compacted", new Date("2026-01-10T00:00:00Z"));
  await pg.sql`UPDATE projection_checkpoint SET last_processed_at='2026-02-01T00:00:00Z'
    WHERE workspace_id='ws_compacted' AND projection='usage_aggregate'`;
  await pg.sql`INSERT INTO projection_checkpoint (workspace_id, projection, last_processed_at)
    VALUES ('ws_compacted', 'observation_reducer', '2026-02-01T00:00:00Z')`;
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("compaction retains an exact trace projection and the detail seam renders compacted zero-span truth", async () => {
  const results = await repository.compactEligiblePartitions("ws_compacted");
  assert.equal(results.length, 2);
  const removed = await pg.sql`SELECT count(*)::int AS count FROM observation WHERE workspace_id='ws_compacted'`;
  assert.equal(removed[0]?.count, 0, "source observation detail was dropped");
  const events = await pg.sql`SELECT count(*)::int AS count FROM observation_event WHERE workspace_id='ws_compacted'`;
  assert.equal(events[0]?.count, 0, "source span journal was dropped");

  const retained = await loadCompactedTrace(pg.sql as never, "ws_compacted", "trace_compacted");
  assert.ok(retained, "production compacted-trace query seam finds the dropped trace");
  const view = compactedDetailView(retained!);
  assert.equal(view.detail_state.state, "compacted");
  assert.equal(view.detail_state.detail_compacted, true);
  assert.match(view.detail_state.note, /detail was compacted on/);
  assert.deepEqual(view.spans, []);
  assert.equal(view.usage.input_tokens, "101");
  assert.equal(view.usage.output_tokens, "202");
  assert.equal(view.cost.cost_microusd, "123456");
  assert.equal(view.usage.usage_fidelity, "exact", "exact tokens remain exact even when price is unknown");
  assert.equal(view.cost.cost_fidelity, "unknown");
});

test("production ingest advances the compaction checkpoint without a fabricated checkpoint row", async () => {
  await pg.sql`SELECT create_month_partition('observation', DATE '2026-03-01')`;
  await pg.sql`SELECT create_month_partition('observation_event', DATE '2026-03-01')`;
  const events = [
    { traceId: 'trace_ingest_compact', kind: 'accepted' as const, seq: 1, occurredAt: '2026-03-31T23:00:01.000Z', profileId: 'public_app', keyId: null, routeId: 'route_ingest', offeringId: null, status: null, reasonCodes: [] },
    { traceId: 'trace_ingest_compact', kind: 'terminal' as const, seq: 2, occurredAt: '2026-03-31T23:00:02.000Z', profileId: 'public_app', keyId: null, routeId: 'route_ingest', offeringId: 'offer_ingest', status: 200, reasonCodes: [], usage: { inputTokens: 11, outputTokens: 22 } },
  ];
  assert.deepEqual(await ingestBatch({ workspaceId: 'ws_compacted', installationId: 'inst_ingest_compact', events }), { accepted: 2, projected: 1 });
  await repository.aggregateClosedHour('ws_compacted', new Date('2026-03-31T23:00:00Z'));
  const checkpoint = await pg.sql<{ projection: string }[]>`SELECT projection FROM projection_checkpoint WHERE workspace_id='ws_compacted'`;
  assert.deepEqual(checkpoint.map((row) => row.projection).sort(), ['observation_reducer', 'usage_aggregate']);
  const results = await repository.compactEligiblePartitions('ws_compacted');
  assert.equal(results.length, 2);
  const retained = await loadCompactedTrace(pg.sql as never, 'ws_compacted', 'trace_ingest_compact');
  assert.ok(retained);
});

test("a detail partition with no per-trace projection cannot be authorized for drop", async () => {
  pg.psql(`
    SELECT create_month_partition('observation_event', DATE '2026-02-01');
    INSERT INTO observation_event (id, workspace_id, trace_id, span_id, installation_id, profile_mode,
      kind, seq, producer_id, idempotency_key, payload, occurred_at, created_at)
    VALUES ('event_orphaned','ws_compacted','trace_without_observation','span_orphaned','inst','public_app',
      'terminal', 1, 'inst', 'trace_without_observation:1', '{"status":"ok"}', '2026-02-10T00:30:00Z','2026-02-10T00:30:00Z');
    UPDATE projection_checkpoint SET last_processed_at='2026-03-01T00:00:00Z' WHERE workspace_id='ws_compacted';
  `);
  await assert.rejects(
    () => repository.compactEligiblePartitions("ws_compacted"),
    /compacted trace projection missing for observation_event/,
  );
  const seal = await pg.sql<{ state: string }[]>`SELECT state FROM storage_partition_seal
    WHERE workspace_id='ws_compacted' AND partition_name='observation_event_202602'`;
  assert.equal(seal[0]?.state, "sealed", "failed proof leaves the detached relation sealed, never drop-authorized");
  const checkpoint = await pg.sql`SELECT count(*)::int AS count FROM storage_compaction_checkpoint
    WHERE workspace_id='ws_compacted' AND partition_name='observation_event_202602'`;
  assert.equal(checkpoint[0]?.count, 0);
});

test("compacted trace retention keeps the 30-day floor and reclaims older rows in bounded batches", async () => {
  await pg.sql`
    INSERT INTO compacted_trace_projection (
      workspace_id, trace_id, compacted_at, input_tokens, output_tokens, cache_read_tokens,
      reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, usage_fidelity,
      cost_microusd, cost_fidelity
    )
    SELECT 'ws_compacted', 'expired_trace_' || value, now() - interval '31 days',
      1, 2, 0, 0, 0, 0, 0, 'exact', 3, 'exact'
    FROM generate_series(1, 5001) value`;
  await pg.sql`
    INSERT INTO compacted_trace_projection (
      workspace_id, trace_id, compacted_at, input_tokens, output_tokens, cache_read_tokens,
      reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, usage_fidelity,
      cost_microusd, cost_fidelity
    ) VALUES ('ws_compacted', 'recent_trace', now() - interval '29 days', 1, 2, 0, 0, 0, 0, 0, 'exact', 3, 'exact')`;

  assert.equal(await repository.pruneCompactedTraceProjections("ws_compacted"), 5001);
  const retained = await pg.sql`SELECT count(*)::int AS count FROM compacted_trace_projection
    WHERE workspace_id='ws_compacted' AND trace_id='recent_trace'`;
  assert.equal(retained[0]?.count, 1);
});
