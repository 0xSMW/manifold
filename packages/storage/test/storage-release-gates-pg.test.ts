// SPEC §13.10 release gates that need a real PostgreSQL catalog and partition DDL.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { CompactionDeferred } from "../src/compactor.ts";
import { PostgresStorageRepository } from "../src/postgres.ts";
import type { ObjectStorageExporter, VerifiedObject } from "../src/object-store.ts";
import { startPg, type PgHarness } from "../../database/test/pg-harness.ts";

class MemoryObjectStore implements ObjectStorageExporter {
  readonly objects = new Map<string, Buffer>();
  configured() { return true; }
  configurationError() { return null; }
  async putImmutable(location: string, key: string, bytes: Buffer, digest: string): Promise<VerifiedObject> {
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    this.objects.set(key, bytes);
    return { uri: `${location}/${key}`, byteCount: bytes.length, sha256: digest };
  }
  async reverifyImmutable(uri: string, expectedBytes: number, digest: string): Promise<VerifiedObject> {
    const key = uri.slice(uri.lastIndexOf("/") + 1); const bytes = this.objects.get(key);
    if (!bytes || bytes.length !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("object missing or hash mismatch");
    return { uri, byteCount: bytes.length, sha256: digest };
  }
  async putImmutableStream(location: string, key: string, chunks: AsyncIterable<Uint8Array>): Promise<VerifiedObject> {
    const parts: Buffer[] = [];
    for await (const chunk of chunks) parts.push(Buffer.from(chunk));
    const bytes = Buffer.concat(parts);
    this.objects.set(key, bytes);
    return { uri: `${location}/${key}`, byteCount: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}

let pg: PgHarness;
let repository: PostgresStorageRepository;
const workspaceId = "ws_storage_release";

before(async () => {
  pg = await startPg({ namePrefix: "mf-storage-release", poolSize: 4 });
  repository = new PostgresStorageRepository(pg.sql as never, new MemoryObjectStore());
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region)
      VALUES ('${workspaceId}', 'storage-release', 'Storage release', 'local');
    INSERT INTO storage_retention_setting (workspace_id, min_trace_days, observation_retention_days,
      cost_ledger_retention_days, export_target, export_location, enabled_at)
      VALUES ('${workspaceId}', 1, 1, 1, 'object_storage', 's3://release-gate/archive', now());
    SELECT create_month_partition('observation', DATE '2024-01-01');
    SELECT create_month_partition('observation', DATE '2024-02-01');
    INSERT INTO observation (
      id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider, status,
      input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms,
      failovers, occurred_at, created_at
    )
    SELECT 'rg_jan_' || n, '${workspaceId}', 'trace_rg_jan_' || n, 'inst-release', 'public_app',
      'route-release', 'openai', 'ok', 3, 5, 1, 2, 11, 7, 0,
      '2024-01-10T03:00:00Z', '2024-01-10T03:00:00Z'
    FROM generate_series(1, 1024) AS n;
    INSERT INTO observation (
      id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider, status,
      input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms,
      failovers, occurred_at, created_at
    )
    SELECT 'rg_feb_' || n, '${workspaceId}', 'trace_rg_feb_' || n, 'inst-release', 'public_app',
      'route-release', 'openai', 'ok', 3, 5, 1, 2, 11, 7, 0,
      '2024-02-10T03:00:00Z', '2024-02-10T03:00:00Z'
    FROM generate_series(1, 1024) AS n;
  `);
  await repository.aggregateClosedHour(workspaceId, new Date("2024-01-10T03:00:00Z"));
  await repository.aggregateClosedHour(workspaceId, new Date("2024-02-10T03:00:00Z"));
  // The deterministic fixture represents fully projected historical windows, not a live lag.
  pg.psql(`INSERT INTO projection_checkpoint (workspace_id, projection, last_processed_at)
    VALUES ('${workspaceId}', 'usage_aggregate', '2027-01-01T00:00:00Z')
    ON CONFLICT (workspace_id, projection) DO UPDATE SET last_processed_at=EXCLUDED.last_processed_at;`);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("repeated old-partition compaction preserves exact aggregate truth and ends below the measured pre-cycle footprint", async () => {
  const aggregateBefore = await pg.sql<{ requests: string; input: string; output: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(input_tokens)::text AS input,
      sum(output_tokens)::text AS output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate
    WHERE workspace_id=${workspaceId} AND grain='hourly'
      AND bucket_start >= '2024-01-01T00:00:00Z' AND bucket_start < '2024-03-01T00:00:00Z'`;
  assert.deepEqual([...aggregateBefore], [{ requests: "2048", input: "6144", output: "10240", cost: "22528" }]);

  const beforeBytes = await repository.measure();
  // Use an observed, rather than guessed, ceiling. Physical relation size varies by Postgres
  // version and page layout; the release gate is the monotonic post-cycle bound.
  const ceilingBytes = beforeBytes - 1;
  assert.ok(ceilingBytes > 0);
  await pg.sql`UPDATE workspace SET storage_ceiling_bytes=${ceilingBytes} WHERE id=${workspaceId}`;

  // Object-storage exports persist one bounded chunk per fire. A deferred run is therefore a
  // successful durable transition, but only `CompactionDeferred` may request a resume and every
  // such resume must add durable chunk progress.
  const MAX_COMPACTION_FIRES = 8;
  let previousChunkCount = 0;
  let deferredFires = 0;
  let terminalOutcomes: readonly { partitionName: string }[] | null = null;
  for (let fire = 0; fire < MAX_COMPACTION_FIRES; fire += 1) {
    try {
      terminalOutcomes = await repository.compactEligiblePartitions(workspaceId);
      break;
    } catch (error) {
      if (!(error instanceof CompactionDeferred)) throw error;
      deferredFires += 1;
      const chunkCount = (await pg.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM storage_export_chunk WHERE workspace_id=${workspaceId}`)[0]?.count ?? 0;
      assert.ok(chunkCount > previousChunkCount,
        `deferred fire ${fire + 1} persisted no chunk (${previousChunkCount} -> ${chunkCount})`);
      previousChunkCount = chunkCount;
    }
  }
  assert.ok(deferredFires > 0, "the bounded object-store path must exercise resumable progress");
  assert.ok(terminalOutcomes !== null, `compaction did not complete within ${MAX_COMPACTION_FIRES} fires`);
  assert.deepEqual(terminalOutcomes.map((outcome) => outcome.partitionName), ["observation_202402"],
    "only the final fire returns its just-completed partition; durable records prove prior completion");
  const completion = await pg.sql<{ manifests: number; checkpoints: number; dropped: number }[]>`
    SELECT
      (SELECT count(*)::int FROM storage_export_manifest WHERE workspace_id=${workspaceId}) AS manifests,
      (SELECT count(*)::int FROM storage_compaction_checkpoint WHERE workspace_id=${workspaceId} AND state='dropped') AS checkpoints,
      (SELECT count(*)::int FROM storage_partition_seal WHERE workspace_id=${workspaceId} AND state='dropped') AS dropped`;
  assert.deepEqual([...completion], [{ manifests: 2, checkpoints: 2, dropped: 2 }],
    "each historical partition is finalized exactly once after its bounded chunk sequence");

  const afterBytes = await repository.measure();
  assert.ok(afterBytes < beforeBytes, `expected compaction to reduce footprint (${beforeBytes} -> ${afterBytes})`);
  assert.ok(afterBytes <= ceilingBytes, `post-cycle footprint ${afterBytes} must be at or below configured ceiling ${ceilingBytes}`);
  assert.equal((await pg.sql`SELECT to_regclass('public.observation_202401')::text AS relation`)[0]?.relation, null);
  assert.equal((await pg.sql`SELECT to_regclass('public.observation_202402')::text AS relation`)[0]?.relation, null);

  const aggregateAfter = await pg.sql<{ requests: string; input: string; output: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(input_tokens)::text AS input,
      sum(output_tokens)::text AS output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate
    WHERE workspace_id=${workspaceId} AND grain='hourly'
      AND bucket_start >= '2024-01-01T00:00:00Z' AND bucket_start < '2024-03-01T00:00:00Z'`;
  assert.deepEqual([...aggregateAfter], [...aggregateBefore],
    "two independently sealed/dropped historical partitions retain exact usage and cost totals");
});
