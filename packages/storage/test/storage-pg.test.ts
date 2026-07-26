// Real-Postgres aggregation/compaction durability tests; no production code is changed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PostgresStorageRepository } from "../src/postgres.js";
import { CompactionDeferred, StorageCompactor } from "../src/compactor.js";
import { startPg, type PgHarness } from "../../database/test/pg-harness.js";

let pg: PgHarness;
let repository: PostgresStorageRepository;
const closedHour = new Date("2026-07-25T09:00:00.000Z");

before(async () => {
  pg = await startPg({ namePrefix: "mf-storage", poolSize: 8 });
  repository = new PostgresStorageRepository(pg.sql as never);
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_storage_a','storage-a','Storage A','local'), ('ws_storage_b','storage-b','Storage B','local');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES
      ('obs_storage_a1','ws_storage_a','trace-a1','inst-a','public_app','route-a','openai','ok',10,20,3,4,100,100,0,'2026-07-25T09:05:00Z','2026-07-25T09:05:00Z'),
      ('obs_storage_a2','ws_storage_a','trace-a2','inst-a','public_app','route-a','openai','error',30,40,5,6,300,300,2,'2026-07-25T09:20:00Z','2026-07-25T09:20:00Z'),
      ('obs_storage_b','ws_storage_b','trace-b','inst-b','public_app','route-b','anthropic','ok',999,999,999,999,999,999,0,'2026-07-25T09:10:00Z','2026-07-25T09:10:00Z');
    INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key)
      VALUES ('job_storage_a','ws_storage_a','storage.compact','{}','storage-pg-a');
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("real-PG measurement equals the direct public catalog total within an explicit one-page tolerance", async () => {
  // Keep the tolerance named and small: the repository and this independent query run as
  // separate snapshots, so catalog bookkeeping may advance by a page while the test executes.
  const CATALOG_SNAPSHOT_TOLERANCE_BYTES = 8 * 1024;
  const measured = await repository.measure();
  const direct = await pg.sql<{ bytes: string }[]>`
    SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint::text AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'p')`;
  const directBytes = Number(direct[0]?.bytes ?? 0);
  assert.ok(Math.abs(measured - directBytes) <= CATALOG_SNAPSHOT_TOLERANCE_BYTES,
    `repository measured ${measured}, direct pg_total_relation_size measured ${directBytes}`);
});

test("closed-hour aggregation is workspace-isolated and exact-replacement preserves totals on retry", async () => {
  await repository.aggregateClosedHour("ws_storage_a", closedHour);
  let totals = await pg.sql<{ requests: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; reasoning_tokens: string; cost_microusd: string; errors: string; failovers: string; latency_ms_sum: string }[]>`
    SELECT sum(requests)::text AS requests, sum(input_tokens)::text AS input_tokens, sum(output_tokens)::text AS output_tokens,
      sum(cache_read_tokens)::text AS cache_read_tokens, sum(reasoning_tokens)::text AS reasoning_tokens,
      sum(cost_microusd)::text AS cost_microusd, sum(errors)::text AS errors, sum(failovers)::text AS failovers,
      sum(latency_ms_sum)::text AS latency_ms_sum
    FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='hourly' AND bucket_start=${closedHour}`;
  assert.deepEqual(totals[0], { requests: "2", input_tokens: "40", output_tokens: "60", cache_read_tokens: "8", reasoning_tokens: "10", cost_microusd: "400", errors: "1", failovers: "2", latency_ms_sum: "400" });
  const foreign = await pg.sql`SELECT count(*)::int AS count FROM usage_aggregate WHERE workspace_id='ws_storage_b'`;
  assert.equal(foreign[0]?.count, 0);
  await repository.aggregateClosedHour("ws_storage_a", closedHour);
  const count = await pg.sql`SELECT count(*)::int AS count FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='hourly' AND bucket_start=${closedHour}`;
  assert.equal(count[0]?.count, 2, "retry replaces the two dimension groups instead of double-counting them");
  totals = await pg.sql`SELECT sum(requests)::text AS requests, sum(cost_microusd)::text AS cost_microusd FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='hourly' AND bucket_start=${closedHour}`;
  assert.deepEqual(totals[0], { requests: "2", cost_microusd: "400" });
});

test("real PG converts a held aggregate lock into resumable deadline work", async () => {
  let releaseLock!: () => void;
  const lockHeld = Promise.withResolvers<void>();
  const held = pg.sql.begin(async (tx) => {
    await tx.unsafe("LOCK TABLE public.usage_aggregate IN ACCESS EXCLUSIVE MODE");
    lockHeld.resolve();
    await new Promise<void>((resolve) => { releaseLock = resolve; });
  });
  await lockHeld.promise;
  try {
    await assert.rejects(
      () => repository.aggregateClosedHour("ws_storage_a", closedHour, Date.now() + 100),
      CompactionDeferred,
    );
  } finally {
    releaseLock();
    await held;
  }
  await repository.aggregateClosedHour("ws_storage_a", closedHour, Date.now() + 5_000);
});

test("real compactor aggregates before a retention blocker and leaves source totals intact", async () => {
  const result = await new StorageCompactor(repository, () => new Date("2026-07-25T10:15:00.000Z")).run("job_storage_a", "ws_storage_a", "worker-pg");
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.deepEqual(result.blocker.missing, ["retention_settings", "export_target"]);
  const source = await pg.sql`SELECT count(*)::int AS count, sum(cost_microusd)::text AS cost FROM observation WHERE workspace_id='ws_storage_a'`;
  assert.deepEqual(source[0], { count: 2, cost: "400" });
  const job = await pg.sql<{ status: string; steps: string[] }[]>`SELECT status, payload->'compaction'->'steps' AS steps FROM job_ledger WHERE id='job_storage_a'`;
  assert.equal(job[0]?.status, "failed");
  assert.deepEqual(job[0]?.steps, ["measured_before", "hourly_aggregated", "aggregate_rollups", "blocked"]);
});

test("real PG enumerates missed closed source hours and checkpoints each exact aggregate", async () => {
  pg.psql(`
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES ('obs_storage_missed','ws_storage_a','trace-missed','inst-a','public_app','route-missed','openai',
      'ok',7,11,2,3,17,77,0,'2026-07-25T07:10:00Z','2026-07-25T07:10:00Z');
  `);
  const missed = await repository.listUncheckpointedClosedHours("ws_storage_a", new Date("2026-07-25T10:15:00Z"));
  assert.deepEqual(missed.map((hour) => hour.toISOString()), ["2026-07-25T07:00:00.000Z"]);
  await repository.aggregateClosedHour("ws_storage_a", missed[0]!);
  const checkpoints = await pg.sql<{ bucket: string }[]>`
    SELECT bucket_start::text AS bucket FROM storage_rollup_checkpoint
    WHERE workspace_id='ws_storage_a' AND target_grain='hourly' ORDER BY bucket_start`;
  assert.ok(checkpoints.some(({ bucket }) => bucket.startsWith("2026-07-25 07:00:00")));
});

test("real PG detects a late backfill in a checkpointed hour and refreshes exact truth", async () => {
  pg.psql(`
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES ('obs_storage_late','ws_storage_a','trace-late','inst-a','public_app','route-missed','openai',
      'ok',13,17,5,7,29,123,1,'2026-07-25T07:40:00Z','2026-07-25T10:20:00Z');
  `);
  const changed = await repository.listUncheckpointedClosedHours("ws_storage_a", new Date("2026-07-25T11:00:00Z"));
  assert.deepEqual(changed.map((hour) => hour.toISOString()), ["2026-07-25T07:00:00.000Z"]);
  await repository.aggregateClosedHour("ws_storage_a", changed[0]!);
  const truth = await pg.sql<{
    requests: string;
    input: string;
    output: string;
    cost: string;
    checkpoint_requests: string;
    checkpoint_cost: string;
  }[]>`
    SELECT sum(a.requests)::text AS requests, sum(a.input_tokens)::text AS input,
      sum(a.output_tokens)::text AS output, sum(a.cost_microusd)::text AS cost,
      c.exact_totals->>'requests' AS checkpoint_requests,
      c.exact_totals->>'cost_microusd' AS checkpoint_cost
    FROM usage_aggregate a
    JOIN storage_rollup_checkpoint c
      ON c.workspace_id=a.workspace_id AND c.target_grain='hourly'
      AND c.bucket_start=a.bucket_start
    WHERE a.workspace_id='ws_storage_a' AND a.grain='hourly'
      AND a.bucket_start='2026-07-25T07:00:00Z'
    GROUP BY c.exact_totals`;
  assert.deepEqual(truth[0], {
    requests: "2", input: "20", output: "28", cost: "46",
    checkpoint_requests: "2", checkpoint_cost: "46",
  });
  assert.deepEqual(
    await repository.listUncheckpointedClosedHours("ws_storage_a", new Date("2026-07-25T11:00:00Z")),
    [],
    "the refreshed exact checkpoint makes the next discovery pass idempotent",
  );
});

test("real PG caps hourly dimensions at 10,000 with one deterministic overflow bucket and exact sums", async () => {
  pg.psql(`
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    SELECT 'obs_card_'||g, 'ws_storage_a', 'trace-card-'||g, 'inst-a', 'public_app', 'route-card-'||g, 'openai',
      'ok', 1, 2, 3, 4, 5, (g % 1000)::int, 0, '2026-07-25T08:10:00Z', '2026-07-25T08:10:00Z'
    FROM generate_series(1,10005) g;
  `);
  const bucket = new Date("2026-07-25T08:00:00Z");
  await repository.aggregateClosedHour("ws_storage_a", bucket);
  const result = await pg.sql<{ groups: number; overflow_groups: number; requests: string; input: string; output: string; cost: string }[]>`
    SELECT count(*)::int AS groups,
      count(*) FILTER (WHERE dims @> '{"overflow":true}'::jsonb)::int AS overflow_groups,
      sum(requests)::text AS requests, sum(input_tokens)::text AS input,
      sum(output_tokens)::text AS output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate
    WHERE workspace_id='ws_storage_a' AND grain='hourly' AND bucket_start=${bucket}`;
  assert.deepEqual(result[0], {
    groups: 10_000, overflow_groups: 1, requests: "10005", input: "10005", output: "20010", cost: "50025",
  });
  await repository.aggregateClosedHour("ws_storage_a", bucket);
  const retry = await pg.sql<{ groups: number; requests: string }[]>`
    SELECT count(*)::int AS groups, sum(requests)::text AS requests FROM usage_aggregate
    WHERE workspace_id='ws_storage_a' AND grain='hourly' AND bucket_start=${bucket}`;
  assert.deepEqual(retry[0], { groups: 10_000, requests: "10005" });
});

test("real PG enforces retention floors and prunes captures in bounded batches", async () => {
  pg.psql(`
    INSERT INTO storage_retention_setting
      (workspace_id, min_detail_hours, journal_retention_hours, capture_retention_hours,
       min_trace_days, observation_retention_days, cost_ledger_retention_days,
       policy_decision_retention_days, hourly_aggregate_retention_days,
       daily_aggregate_retention_days, export_target, export_location, enabled_at)
    VALUES ('ws_storage_a',24,72,24,7,30,30,90,14,400,'local_filesystem','/tmp/manifold-storage-test',now());
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers,
      capture_ref, occurred_at, created_at)
    SELECT 'obs_capture_'||g, 'ws_storage_a', 'trace-capture-'||g, 'inst-a', 'public_app', 'route-capture', 'openai',
      'ok',0,0,0,0,0,1,0,'{"bounded":true}'::jsonb,'2026-07-23T00:00:00Z','2026-07-23T00:00:00Z'
    FROM generate_series(1,5001) g;
  `);
  await assert.rejects(
    () => pg.sql`UPDATE storage_retention_setting SET policy_decision_retention_days=89 WHERE workspace_id='ws_storage_a'`,
    /storage_retention_policy_floor_chk/,
  );
  await assert.rejects(
    () => pg.sql`UPDATE storage_retention_setting SET cost_ledger_retention_days=6 WHERE workspace_id='ws_storage_a'`,
    /storage_retention_cost_floor_chk/,
  );
  const pruned = await repository.pruneExpiredCaptures("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  assert.equal(pruned, 5001);
  const captures = await pg.sql<{ retained: number }[]>`
    SELECT count(*) FILTER (WHERE capture_ref IS NOT NULL)::int AS retained
    FROM observation WHERE workspace_id='ws_storage_a' AND id LIKE 'obs_capture_%'`;
  assert.equal(captures[0]?.retained, 0);
});

test("real PG prunes hourly only after daily and daily only after monthly, preserving exact monthly truth", async () => {
  const hourOne = new Date("2026-01-10T03:00:00Z");
  const hourTwo = new Date("2026-01-10T04:00:00Z");
  await pg.sql`
    INSERT INTO usage_aggregate
      (workspace_id, grain, bucket_start, dims, dims_hash, requests, input_tokens, output_tokens,
       cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
       cost_microusd, errors, failovers, latency_ms_sum, latency_ms_p95)
    VALUES
      ('ws_storage_a','hourly',${hourOne},'{"provider":"openai","app_id":"a","team_id":"t","status":"ok"}','old-a',
       2,3,5,7,11,13,17,19,23,0,0,200,100),
      ('ws_storage_a','hourly',${hourTwo},'{"provider":"openai","app_id":"a","team_id":"t","status":"ok"}','old-b',
       29,31,37,41,43,47,53,59,61,1,2,300,200)`;
  await repository.rollupClosedWindows("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  await pg.sql`UPDATE storage_retention_setting
    SET hourly_aggregate_retention_days=1, daily_aggregate_retention_days=1
    WHERE workspace_id='ws_storage_a'`;
  const before = await pg.sql<{ requests: string; cost: string; p95: number | null }[]>`
    SELECT sum(requests)::text AS requests, sum(cost_microusd)::text AS cost, max(latency_ms_p95) AS p95
    FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='monthly'
      AND bucket_start='2026-01-01T00:00:00Z'`;
  assert.deepEqual(before[0], { requests: "31", cost: "84", p95: null },
    "coarser percentile is null because max-of-p95 is not mathematically mergeable");
  const prunable = await pg.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM usage_aggregate WHERE workspace_id='ws_storage_a'
      AND grain IN ('hourly','daily')
      AND bucket_start >= '2026-01-01T00:00:00Z' AND bucket_start < '2026-02-01T00:00:00Z'`;
  const deleted = await repository.pruneExpiredAggregateGrains("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  assert.ok(deleted >= (prunable[0]?.count ?? 0),
    "the workspace-wide pass may also prune other expired, checkpointed fixture buckets");
  const grains = await pg.sql<{ grain: string; requests: string; cost: string }[]>`
    SELECT grain, sum(requests)::text AS requests, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id='ws_storage_a'
      AND bucket_start >= '2026-01-01T00:00:00Z' AND bucket_start < '2026-02-01T00:00:00Z'
    GROUP BY grain ORDER BY grain`;
  assert.deepEqual([...grains], [{ grain: "monthly", requests: "31", cost: "84" }]);
});

test("real PG restores a pruned rollup from durable contributions when a late hour arrives, without double counting", async () => {
  const hourOne = new Date("2026-02-10T03:00:00Z");
  const hourTwo = new Date("2026-02-10T04:00:00Z");
  pg.psql(`
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES
      ('obs_rollup_durable_1','ws_storage_a','trace-rollup-durable-1','inst-a','public_app','route-durable','openai',
       'ok',1,2,0,0,10,10,0,'2026-02-10T03:05:00Z','2026-02-10T03:05:00Z'),
      ('obs_rollup_durable_2','ws_storage_a','trace-rollup-durable-2','inst-a','public_app','route-durable','openai',
       'ok',3,4,0,0,20,20,0,'2026-02-10T04:05:00Z','2026-02-10T04:05:00Z');
  `);
  await repository.aggregateClosedHour("ws_storage_a", hourOne);
  await repository.aggregateClosedHour("ws_storage_a", hourTwo);
  await repository.rollupClosedWindows("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  const initial = await pg.sql<{ requests: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='monthly'
      AND bucket_start='2026-02-01T00:00:00Z'`;
  assert.deepEqual(initial[0], { requests: "2", cost: "30" });

  await repository.pruneExpiredAggregateGrains("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  const pruned = await pg.sql<{ grain: string; count: number }[]>`
    SELECT grain, count(*)::int AS count FROM usage_aggregate
    WHERE workspace_id='ws_storage_a' AND bucket_start >= '2026-02-01T00:00:00Z' AND bucket_start < '2026-03-01T00:00:00Z'
    GROUP BY grain ORDER BY grain`;
  assert.deepEqual([...pruned], [{ grain: "monthly", count: 1 }]);

  pg.psql(`
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES ('obs_rollup_durable_late','ws_storage_a','trace-rollup-durable-late','inst-a','public_app','route-durable','openai',
      'ok',5,6,0,0,7,30,0,'2026-02-10T03:40:00Z','2026-07-25T12:01:00Z');
  `);
  const changed = await repository.listUncheckpointedClosedHours("ws_storage_a", new Date("2026-07-25T13:00:00Z"));
  assert.ok(changed.some((hour) => hour.getTime() === hourOne.getTime()));
  await repository.aggregateClosedHour("ws_storage_a", hourOne);
  await repository.rollupClosedWindows("ws_storage_a", new Date("2026-07-25T13:00:00Z"));

  const corrected = await pg.sql<{ grain: string; requests: string; cost: string }[]>`
    SELECT grain, sum(requests)::text AS requests, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id='ws_storage_a'
      AND bucket_start >= '2026-02-01T00:00:00Z' AND bucket_start < '2026-03-01T00:00:00Z'
    GROUP BY grain ORDER BY grain`;
  assert.deepEqual([...corrected], [
    { grain: "daily", requests: "3", cost: "37" },
    { grain: "hourly", requests: "2", cost: "17" },
    { grain: "monthly", requests: "3", cost: "37" },
  ]);
  await repository.rollupClosedWindows("ws_storage_a", new Date("2026-07-25T13:00:00Z"));
  const idempotent = await pg.sql<{ requests: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='monthly'
      AND bucket_start='2026-02-01T00:00:00Z'`;
  assert.deepEqual(idempotent[0], { requests: "3", cost: "37" });
});

test("0029-to-0030 upgrade bootstraps only complete retained source and blocks already-pruned legacy truth", async () => {
  const retainedHour = new Date("2025-01-10T03:00:00Z");
  const retainedDay = new Date("2025-01-10T00:00:00Z");
  const retainedMonth = new Date("2025-01-01T00:00:00Z");
  await pg.sql`
    INSERT INTO usage_aggregate
      (workspace_id, grain, bucket_start, dims, dims_hash, requests, input_tokens, output_tokens,
       cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
       cost_microusd, errors, failovers, latency_ms_sum, latency_ms_p95)
    VALUES ('ws_storage_a','hourly',${retainedHour},'{}','upgrade-retained-hour',2,0,0,0,0,0,0,0,20,0,0,0,NULL)`;
  await repository.rollupClosedWindows("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  // This is the just-upgraded 0029 state: durable legacy checkpoints exist but 0030's new
  // source-proof table is empty. Pruning must wait for a runtime exact baseline.
  await pg.sql`DELETE FROM storage_rollup_source_checkpoint
    WHERE workspace_id='ws_storage_a' AND bucket_start IN (${retainedDay}, ${retainedMonth})`;
  await repository.pruneExpiredAggregateGrains("ws_storage_a", new Date("2026-07-25T12:00:00Z"), 1);
  const retainedSource = await pg.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM usage_aggregate
    WHERE workspace_id='ws_storage_a' AND grain='hourly' AND bucket_start=${retainedHour}`;
  assert.equal(retainedSource[0]?.count, 1);

  await repository.rollupClosedWindows("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  const baseline = await pg.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM storage_rollup_source_checkpoint
    WHERE workspace_id='ws_storage_a' AND bucket_start IN (${retainedDay}, ${retainedMonth})`;
  assert.ok((baseline[0]?.count ?? 0) >= 2, "complete retained source establishes durable 0030 contributions");
  await repository.pruneExpiredAggregateGrains("ws_storage_a", new Date("2026-07-25T12:00:00Z"));
  const retainedTruth = await pg.sql<{ requests: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='monthly' AND bucket_start=${retainedMonth}`;
  assert.deepEqual(retainedTruth[0], { requests: "2", cost: "20" });

  const prunedMonth = new Date("2024-01-01T00:00:00Z");
  const prunedDay = new Date("2024-01-10T00:00:00Z");
  await pg.sql`
    INSERT INTO usage_aggregate
      (workspace_id, grain, bucket_start, dims, dims_hash, requests, input_tokens, output_tokens,
       cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
       cost_microusd, errors, failovers, latency_ms_sum, latency_ms_p95)
    VALUES ('ws_storage_a','monthly',${prunedMonth},'{}','upgrade-pruned-month',2,0,0,0,0,0,0,0,20,0,0,0,NULL)`;
  await pg.sql`
    INSERT INTO storage_rollup_checkpoint
      (workspace_id, source_grain, target_grain, bucket_start, bucket_end, exact_totals, completed_at)
    VALUES ('ws_storage_a','daily','monthly',${prunedMonth},'2024-02-01T00:00:00Z',
      jsonb_build_object('requests',2,'input_tokens',0,'output_tokens',0,'cache_read_tokens',0,'reasoning_tokens',0,
        'cache_write_tokens',0,'audio_input_tokens',0,'audio_output_tokens',0,'cost_microusd',20,
        'errors',0,'failovers',0,'latency_ms_sum',0),now())`;
  await repository.pruneExpiredAggregateGrains("ws_storage_a", new Date("2026-07-25T12:00:00Z"), 1);
  const beforeForwardFix = await pg.sql<{ requests: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='monthly' AND bucket_start=${prunedMonth}`;
  assert.deepEqual(beforeForwardFix[0], { requests: "2", cost: "20" }, "already-pruned 0029 source cannot gain unsafe deletion authority");
  await pg.sql`
    INSERT INTO usage_aggregate
      (workspace_id, grain, bucket_start, dims, dims_hash, requests, input_tokens, output_tokens,
       cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
       cost_microusd, errors, failovers, latency_ms_sum, latency_ms_p95)
    VALUES ('ws_storage_a','daily',${prunedDay},'{}','upgrade-pruned-day-late',1,0,0,0,0,0,0,0,7,0,0,0,NULL)`;
  await assert.rejects(
    () => repository.rollupClosedWindows("ws_storage_a", new Date("2026-07-25T12:00:00Z")),
    /rollup source proof missing or incomplete for monthly 2024-01-01T00:00:00.000Z/,
  );
  const durableLegacy = await pg.sql<{ requests: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id='ws_storage_a' AND grain='monthly' AND bucket_start=${prunedMonth}`;
  assert.deepEqual(durableLegacy[0], { requests: "2", cost: "20" }, "failed forward-fix preserves legacy target truth");
});

test("a second workspace row violates ADR-0021 and makes a shared monthly child fail closed", async () => {
  pg.psql(`
    SELECT create_month_partition('observation', DATE '2026-01-01');
    UPDATE storage_retention_setting SET observation_retention_days=7
      WHERE workspace_id='ws_storage_a';
    INSERT INTO storage_retention_setting (workspace_id, observation_retention_days, export_target, export_location, enabled_at)
      VALUES ('ws_storage_b', 30, 'local_filesystem', '/tmp/manifold-storage-test', now());
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES
      ('obs_storage_old_a','ws_storage_a','trace-old-a','inst-a','public_app','route-a','openai','ok',1,1,0,0,1,1,0,'2026-01-10T00:00:00Z','2026-01-10T00:00:00Z'),
      ('obs_storage_old_b','ws_storage_b','trace-old-b','inst-b','public_app','route-b','openai','ok',1,1,0,0,1,1,0,'2026-01-10T00:00:00Z','2026-01-10T00:00:00Z');
  `);
  await assert.rejects(() => repository.compactEligiblePartitions("ws_storage_a"), /violates ADR-0021 one-workspace invariant/);
  const rows = await pg.sql`SELECT count(*)::int AS count FROM observation WHERE created_at >= '2026-01-01' AND created_at < '2026-02-01'`;
  assert.equal(rows[0]?.count, 2);
});

test("real PG pressure crossings persist deterministic capture/journal policy, bounded alerts, and never alter gateway admission", async () => {
  const percentageForTier = [
    [60, "normal"], [75, "warning"], [90, "high"], [97, "critical"], [105, "emergency"], [60, "normal"],
  ] as const;
  const expected = {
    normal: { capture: "full", sample: "1", journal: "full", compact: false },
    warning: { capture: "full", sample: "0.5", journal: "full", compact: true },
    high: { capture: "redacted", sample: "0.1", journal: "full", compact: true },
    critical: { capture: "metadata", sample: "0", journal: "full", compact: true },
    emergency: { capture: "none", sample: "0", journal: "aggregate_only", compact: true },
  } as const;

  for (const [offset, [targetPct, tier]] of percentageForTier.entries()) {
    const bytes = await repository.measure();
    // Effective ceiling is C - max(8% of C, index bytes). Pick a configured ceiling satisfying
    // both reserves, rather than assuming the fixture's index reserve is smaller than 8%.
    const desiredEffective = Math.ceil(bytes * 100 / targetPct);
    const configuredCeiling = Math.max(Math.ceil(desiredEffective / 0.92), desiredEffective + Number((await pg.sql<{ bytes: string }[]>`
      SELECT coalesce(sum(pg_indexes_size(c.oid)), 0)::bigint::text AS bytes FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'p')`)[0]!.bytes));
    await pg.sql`UPDATE workspace SET storage_ceiling_bytes = ${configuredCeiling} WHERE id = 'ws_storage_a'`;
    const result = await repository.measurePressure("ws_storage_a", new Date(`2026-07-25T${String(12 + offset).padStart(2, "0")}:00:00.000Z`));
    assert.equal(result.tier, tier);
    assert.ok(Math.abs(result.usedPct - targetPct) < 0.1, `expected near ${targetPct}%, got ${result.usedPct}%`);
    assert.equal(result.policy.captureMode, expected[tier].capture);
    assert.equal(String(result.policy.payloadSampleRate), expected[tier].sample);
    assert.equal(result.policy.journalMode, expected[tier].journal);
    assert.equal(result.policy.triggerCompaction, expected[tier].compact);
  }

  const state = await pg.sql<{ tier: string; capture_mode: string; payload_sample_rate: string; journal_mode: string; trigger_compaction: boolean }[]>`
    SELECT tier, capture_mode, payload_sample_rate::text, journal_mode, trigger_compaction
    FROM storage_pressure_state WHERE workspace_id = 'ws_storage_a'`;
  assert.deepEqual(state[0], { tier: "normal", capture_mode: "full", payload_sample_rate: "1", journal_mode: "full", trigger_compaction: false });
  const alerts = await pg.sql<{ tier: string; transition_count: number; resolved: boolean }[]>`
    SELECT tier, transition_count, resolved_at IS NOT NULL AS resolved FROM storage_pressure_alert
    WHERE workspace_id = 'ws_storage_a' ORDER BY tier`;
  assert.deepEqual([...alerts], [
    { tier: "critical", transition_count: 1, resolved: true },
    { tier: "emergency", transition_count: 1, resolved: true },
    { tier: "forecast_exhaustion_14d", transition_count: 1, resolved: true },
    { tier: "high", transition_count: 1, resolved: true },
    { tier: "warning", transition_count: 1, resolved: true },
  ]);
  const pressureCompactions = await pg.sql`SELECT count(*)::int AS count FROM job_ledger
    WHERE workspace_id = 'ws_storage_a' AND kind = 'storage.compact' AND payload ? 'pressure'`;
  assert.equal(pressureCompactions[0]?.count, 4, "warning/high/critical/emergency each schedule the compactor once on entry");
  const alertCountBefore = await pg.sql`SELECT count(*)::int AS count FROM storage_pressure_alert WHERE workspace_id = 'ws_storage_a'`;
  await repository.measurePressure("ws_storage_a", new Date("2026-07-25T23:00:00.000Z"));
  const alertCountAfter = await pg.sql`SELECT count(*)::int AS count FROM storage_pressure_alert WHERE workspace_id = 'ws_storage_a'`;
  assert.equal(alertCountAfter[0]?.count, alertCountBefore[0]?.count, "same-tier measurement does not duplicate alerts");
  const gatewayMutation = await pg.sql`SELECT count(*)::int AS count FROM gateway_rate_limit_state WHERE workspace_id = 'ws_storage_a'`;
  assert.equal(gatewayMutation[0]?.count, 0, "storage pressure only changes ingest/compaction posture; it creates no gateway denial state");
});

test("real PG pressure measurement persists regression growth and an effective-ceiling forecast", async () => {
  const now = new Date("2026-07-25T02:00:00.000Z");
  const measured = await repository.measure();
  await pg.sql`UPDATE workspace SET storage_ceiling_bytes = ${measured * 10} WHERE id = 'ws_storage_b'`;
  await pg.sql`
    INSERT INTO storage_stat (id, workspace_id, measured_at, total_bytes, table_bytes, index_bytes, toast_bytes, ceiling_bytes, effective_ceiling_bytes, used_pct, tier)
    VALUES
      ('sst_growth_1', 'ws_storage_b', '2026-07-25T01:30:00.000Z', ${measured - 200}, '{}'::jsonb, 0, 0, ${measured * 10}, ${measured * 9}, 1, 'normal'),
      ('sst_growth_2', 'ws_storage_b', '2026-07-25T01:45:00.000Z', ${measured - 100}, '{}'::jsonb, 0, 0, ${measured * 10}, ${measured * 9}, 1, 'normal')`;
  const result = await repository.measurePressure("ws_storage_b", now);
  assert.ok((result.growthBytesPerDay ?? 0) > 0, "increasing 15-minute samples must produce positive daily growth");
  assert.ok(result.forecastExhaustionAt instanceof Date);
  const [stored] = await pg.sql<{ growth_bytes_per_day: string | null; forecast_exhaustion_at: string | null }[]>`
    SELECT growth_bytes_per_day::text, forecast_exhaustion_at
    FROM storage_stat WHERE workspace_id='ws_storage_b' ORDER BY measured_at DESC LIMIT 1`;
  assert.equal(stored?.growth_bytes_per_day, String(result.growthBytesPerDay));
  assert.ok(stored?.forecast_exhaustion_at);
});

test("real PG emits one forecast-exhaustion alert inside fourteen days below warning and resolves it on recovery", async () => {
  const measured = await repository.measure();
  // Keep occupancy below warning while a deliberately steep, persisted recent slope forecasts exhaustion soon.
  await pg.sql`INSERT INTO storage_stat (id, workspace_id, measured_at, total_bytes, table_bytes, index_bytes, toast_bytes, ceiling_bytes, effective_ceiling_bytes, used_pct, tier)
    VALUES ('sst_forecast_fast_1','ws_storage_b','2026-07-25T01:30:00.000Z',${Math.max(1, measured - 50_000_000)},'{}'::jsonb,0,0,${measured * 3},${measured * 2},1,'normal'),
      ('sst_forecast_fast_2','ws_storage_b','2026-07-25T01:45:00.000Z',${Math.max(1, measured - 25_000_000)},'{}'::jsonb,0,0,${measured * 3},${measured * 2},1,'normal')`;
  await pg.sql`UPDATE workspace SET storage_ceiling_bytes = ${Math.ceil((measured * 2) / 0.92)} WHERE id = 'ws_storage_b'`;
  const imminent = await repository.measurePressure("ws_storage_b", new Date("2026-07-25T02:15:00.000Z"));
  assert.equal(imminent.tier, "normal");
  assert.ok(imminent.forecastExhaustionAt && imminent.forecastExhaustionAt.getTime() <= new Date("2026-08-08T02:15:00.000Z").getTime());
  const active = await pg.sql<{ transition_count: number; resolved: boolean }[]>`
    SELECT transition_count, resolved_at IS NOT NULL AS resolved FROM storage_pressure_alert
    WHERE workspace_id='ws_storage_b' AND tier='forecast_exhaustion_14d'`;
  assert.deepEqual([...active], [{ transition_count: 1, resolved: false }]);
  await repository.measurePressure("ws_storage_b", new Date("2026-07-25T02:30:00.000Z"));
  const repeated = await pg.sql<{ transition_count: number }[]>`
    SELECT transition_count FROM storage_pressure_alert WHERE workspace_id='ws_storage_b' AND tier='forecast_exhaustion_14d'`;
  assert.equal(repeated[0]?.transition_count, 1, "repeated imminent forecasts do not duplicate alerts");
  await pg.sql`UPDATE workspace SET storage_ceiling_bytes = ${measured * 10_000} WHERE id = 'ws_storage_b'`;
  await repository.measurePressure("ws_storage_b", new Date("2026-07-25T02:45:00.000Z"));
  const recovered = await pg.sql<{ resolved: boolean }[]>`
    SELECT resolved_at IS NOT NULL AS resolved FROM storage_pressure_alert
    WHERE workspace_id='ws_storage_b' AND tier='forecast_exhaustion_14d'`;
  assert.deepEqual([...recovered], [{ resolved: true }]);
});
