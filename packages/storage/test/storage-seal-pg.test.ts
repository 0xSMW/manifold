import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES, PostgresStorageRepository } from "../src/postgres.ts";
import type { ObjectStorageExporter, VerifiedObject } from "../src/object-store.ts";
import { startPg, type PgHarness } from "../../database/test/pg-harness.ts";

class FailOnceObjectStore implements ObjectStorageExporter {
  failStreamingUpload = true;
  rejectManifestVerification = false;
  readonly objects = new Map<string, Buffer>();
  readonly reverifiedUris: string[] = [];
  configured() { return true; }
  configurationError() { return null; }
  async putImmutable(location: string, key: string, bytes: Buffer, digest: string): Promise<VerifiedObject> {
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    this.objects.set(key, bytes);
    return { uri: `${location}/${key}`, byteCount: bytes.length, sha256: digest };
  }
  async reverifyImmutable(uri: string, expectedBytes: number, digest: string): Promise<VerifiedObject> {
    this.reverifiedUris.push(uri);
    if (this.rejectManifestVerification && uri.includes("-manifest-")) throw new Error("injected manifest verification failure");
    const key = uri.slice(uri.lastIndexOf("/") + 1); const bytes = this.objects.get(key);
    if (!bytes || bytes.length !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("object missing or hash mismatch");
    return { uri, byteCount: bytes.length, sha256: digest };
  }
  async putImmutableStream(location: string, key: string, chunks: AsyncIterable<Uint8Array>): Promise<VerifiedObject> {
    const bytes: Buffer[] = [];
    for await (const chunk of chunks) bytes.push(Buffer.from(chunk));
    if (this.failStreamingUpload) { this.failStreamingUpload = false; throw new Error("injected upload crash"); }
    const body = Buffer.concat(bytes);
    this.objects.set(key, body);
    return { uri: `${location}/${key}`, byteCount: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  }
}

let pg: PgHarness;
let repository: PostgresStorageRepository;
const store = new FailOnceObjectStore();
const workspaceId = "ws_storage_seal";
const partition = "observation_202601";

before(async () => {
  pg = await startPg({ namePrefix: "mf-storage-seal", poolSize: 4 });
  repository = new PostgresStorageRepository(pg.sql as never, store);
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('${workspaceId}','storage-seal','Storage seal','local');
    SELECT create_month_partition('observation', DATE '2026-01-01');
    INSERT INTO storage_retention_setting (workspace_id, min_trace_days, observation_retention_days,
      cost_ledger_retention_days, export_target, export_location, enabled_at)
      VALUES ('${workspaceId}', 1, 1, 1, 'object_storage', 's3://test-archive/retention', now());
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
      SELECT CASE WHEN n IN (500, 501) THEN 'obs_same_id' ELSE 'obs_sealed_' || n END, '${workspaceId}', 'trace-sealed-' || n, 'inst-seal','public_app','route-seal','openai','ok',1,2,0,0,0,0,0,3,4,0,
        '2026-01-10T00:00:00Z'::timestamptz + n * interval '1 microsecond',
        '2026-01-10T00:00:00Z'::timestamptz + n * interval '1 microsecond'
      FROM generate_series(1, 501) AS n;
  `);
  await repository.aggregateClosedHour(workspaceId, new Date("2026-01-10T00:00:00Z"));
  pg.psql(`UPDATE projection_checkpoint SET last_processed_at='2026-12-31T00:00:00Z'
    WHERE workspace_id='${workspaceId}' AND projection='usage_aggregate';`);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("real PG resumes more than 500 rows at an exact sub-millisecond cursor without reread, then checkpoints and drops once", async () => {
  const aggregateBeforeCrash = await pg.sql<{ requests: string; input: string; output: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(input_tokens)::text AS input,
      sum(output_tokens)::text AS output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate
    WHERE workspace_id=${workspaceId} AND grain='hourly'
      AND bucket_start >= '2026-01-01T00:00:00Z' AND bucket_start < '2026-02-01T00:00:00Z'`;
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /storage chunk persisted/);
  const first = await pg.sql<{ relation_oid: string; object_key: string; exported_at: string; state: string; count: number }[]>`
    SELECT s.relation_oid::text, s.object_key, a.exported_at::text, s.state,
      (SELECT count(*)::int FROM storage_partition_seal WHERE workspace_id=${workspaceId}) AS count
    FROM storage_partition_seal s JOIN storage_export_attempt a ON a.workspace_id=s.workspace_id AND a.partition_name=s.partition_name
    WHERE s.workspace_id=${workspaceId} AND s.partition_name=${partition}`;
  assert.equal(first[0]?.state, "sealed");
  assert.equal(first[0]?.count, 1);
  const sealedOid = first[0]!.relation_oid;
  const objectKey = first[0]!.object_key;
  const exportedAt = first[0]!.exported_at;
  const firstChunk = await pg.sql<{ chunk_number: number; cursor_row_id: string; row_count: number }[]>`SELECT chunk_number, cursor_row_id, row_count::int FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${partition}`;
  assert.equal(firstChunk[0]?.chunk_number, 1); assert.equal(firstChunk[0]?.row_count, 500);
  const deferredAttempt = await pg.sql<{ state: string; last_error: string | null }[]>`SELECT state, last_error FROM storage_export_attempt WHERE workspace_id=${workspaceId} AND partition_name=${partition}`;
  assert.deepEqual([...deferredAttempt], [{ state: "exporting", last_error: null }]);
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId, new Date(), 1, Date.now()), /deadline reached/);
  const afterDeadline = await pg.sql<{ chunks: number; state: string; last_error: string | null }[]>`SELECT (SELECT count(*)::int FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${partition}) AS chunks, state, last_error FROM storage_export_attempt WHERE workspace_id=${workspaceId} AND partition_name=${partition}`;
  assert.deepEqual([...afterDeadline], [{ chunks: 1, state: "exporting", last_error: null }]);
  assert.equal((await pg.sql`SELECT to_regclass(${`public.${partition}`})::text AS relation`)[0]?.relation, partition);
  const aggregateAfterCrash = await pg.sql<{ requests: string; input: string; output: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(input_tokens)::text AS input,
      sum(output_tokens)::text AS output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate
    WHERE workspace_id=${workspaceId} AND grain='hourly'
      AND bucket_start >= '2026-01-01T00:00:00Z' AND bucket_start < '2026-02-01T00:00:00Z'`;
  assert.deepEqual(aggregateAfterCrash, aggregateBeforeCrash,
    "a crash after DETACH leaves the aggregate truth present while source detail remains sealed");

  // The parent has no attached January partition after the durable seal; the default catches a
  // writer while the export is paused. This row must survive dropping the sealed relation.
  pg.psql(`INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
    status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES ('obs_after_detach','${workspaceId}','trace-after','inst-seal','public_app','route-seal','openai','ok',5,6,0,0,7,8,0,'2026-01-11T00:00:00Z','2026-01-11T00:00:00Z');`);

  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /storage chunk persisted/);
  const secondChunk = await pg.sql<{ chunk_number: number; cursor_row_id: string; row_count: number }[]>`SELECT chunk_number, cursor_row_id, row_count::int FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${partition} ORDER BY chunk_number`;
  assert.deepEqual([...secondChunk].map((chunk) => ({ number: chunk.chunk_number, rows: chunk.row_count })), [{ number: 1, rows: 500 }, { number: 2, rows: 1 }]);
  // A privileged fixture mutation models corruption outside the append-only application role.
  // Finalization must prove every source interval, rather than trusting the chunk row_count.
  pg.psql(`UPDATE storage_export_chunk SET row_count=499 WHERE workspace_id='${workspaceId}' AND partition_name='${partition}' AND chunk_number=1;`);
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /row-count proof failed/);
  assert.equal((await pg.sql`SELECT to_regclass(${`public.${partition}`})::text AS relation`)[0]?.relation, partition);
  pg.psql(`UPDATE storage_export_chunk SET row_count=500 WHERE workspace_id='${workspaceId}' AND partition_name='${partition}' AND chunk_number=1;`);
  const firstObject = [...store.objects.entries()].find(([key]) => key.includes(".chunk-1-"));
  assert.ok(firstObject);
  store.objects.delete(firstObject[0]);
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /object missing or hash mismatch/);
  assert.equal((await pg.sql<{ state: string }[]>`SELECT state FROM storage_export_attempt WHERE workspace_id=${workspaceId} AND partition_name=${partition}`)[0]?.state, "exporting", "failed chunk reread must leave proof resumable");
  store.objects.set(firstObject[0], firstObject[1]);
  store.rejectManifestVerification = true;
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /injected manifest verification failure/);
  assert.equal((await pg.sql<{ state: string }[]>`SELECT state FROM storage_export_attempt WHERE workspace_id=${workspaceId} AND partition_name=${partition}`)[0]?.state, "exporting", "manifest failure must not authorize drop");
  assert.equal((await pg.sql`SELECT to_regclass(${`public.${partition}`})::text AS relation`)[0]?.relation, partition);
  store.rejectManifestVerification = false;
  const outcomes = await repository.compactEligiblePartitions(workspaceId);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.partitionName, partition);
  const final = await pg.sql<{ relation_oid: string; object_key: string; exported_at: string; state: string; checkpoint: string }[]>`
    SELECT s.relation_oid::text, s.object_key, a.exported_at::text, s.state, c.state AS checkpoint
    FROM storage_partition_seal s JOIN storage_export_attempt a ON a.workspace_id=s.workspace_id AND a.partition_name=s.partition_name
    JOIN storage_compaction_checkpoint c ON c.workspace_id=s.workspace_id AND c.partition_name=s.partition_name
    WHERE s.workspace_id=${workspaceId} AND s.partition_name=${partition}`;
  assert.deepEqual({ oid: final[0]?.relation_oid, key: final[0]?.object_key, exportedAt: final[0]?.exported_at }, { oid: sealedOid, key: objectKey, exportedAt });
  assert.equal(final[0]?.state, "dropped");
  assert.equal(final[0]?.checkpoint, "dropped");
  assert.equal((await pg.sql`SELECT to_regclass(${`public.${partition}`})::text AS relation`)[0]?.relation, null);
  const survivor = await pg.sql`SELECT count(*)::int AS count FROM observation WHERE workspace_id=${workspaceId} AND id='obs_after_detach'`;
  assert.equal(survivor[0]?.count, 1);
  const aggregateAfterRecovery = await pg.sql<{ requests: string; input: string; output: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(input_tokens)::text AS input,
      sum(output_tokens)::text AS output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate
    WHERE workspace_id=${workspaceId} AND grain='hourly'
      AND bucket_start >= '2026-01-01T00:00:00Z' AND bucket_start < '2026-02-01T00:00:00Z'`;
  assert.deepEqual(aggregateAfterRecovery, aggregateBeforeCrash,
    "resuming the destructive phase preserves the exact usage and cost totals recorded before the crash");
  const exported = [...store.objects.entries()]
    .filter(([key]) => key.startsWith(`${objectKey}.chunk-`))
    .map(([, bytes]) => gunzipSync(bytes).toString("utf8")).join("");
  assert.match(exported, /obs_sealed/);
  assert.doesNotMatch(exported, /obs_after_detach/);
  assert.equal((exported.match(/"id":"obs_sealed_/g) ?? []).length, 499, "exact text cursor must neither reread nor skip rows");
  assert.equal((exported.match(/"id":"obs_same_id"/g) ?? []).length, 2,
    "two rows with the same ID at different microsecond timestamps must both cross the chunk boundary");
  const repeated = await repository.compactEligiblePartitions(workspaceId);
  assert.deepEqual(repeated, []);
  const once = await pg.sql<{ manifests: number; checkpoints: number; chunks: number }[]>`SELECT
    (SELECT count(*)::int FROM storage_export_manifest WHERE workspace_id=${workspaceId} AND partition_name=${partition}) AS manifests,
    (SELECT count(*)::int FROM storage_compaction_checkpoint WHERE workspace_id=${workspaceId} AND partition_name=${partition}) AS checkpoints,
    (SELECT count(*)::int FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${partition}) AS chunks`;
  assert.deepEqual([...once], [{ manifests: 1, checkpoints: 1, chunks: 2 }]);
});

test("real PG local export writes a verified manifest and drops only its sealed partition", async () => {
  const localRoot = `/tmp/manifold-storage-seal-${process.pid}`;
  pg.psql(`
    UPDATE storage_retention_setting SET export_target='local_filesystem', export_location='${localRoot}' WHERE workspace_id='${workspaceId}';
    SELECT create_month_partition('observation', DATE '2026-02-01');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES ('obs_local_export','${workspaceId}','trace-local','inst-seal','public_app','route-seal','openai','ok',1,1,0,0,0,0,0,1,1,0,'2026-02-10T00:00:00Z','2026-02-10T00:00:00Z');
  `);
  await repository.aggregateClosedHour(workspaceId, new Date("2026-02-10T00:00:00Z"));
  const outcomes = await repository.compactEligiblePartitions(workspaceId);
  assert.ok(outcomes.some((outcome) => outcome.partitionName === "observation_202602"));
  const evidence = await pg.sql<{ state: string; checkpoint: string; target_kind: string; target_uri: string }[]>`
    SELECT s.state, c.state AS checkpoint, m.target_kind, m.target_uri FROM storage_partition_seal s
    JOIN storage_compaction_checkpoint c ON c.workspace_id=s.workspace_id AND c.partition_name=s.partition_name
    JOIN storage_export_manifest m ON m.workspace_id=s.workspace_id AND m.id=c.export_manifest_id
    WHERE s.workspace_id=${workspaceId} AND s.partition_name='observation_202602'`;
  assert.deepEqual({ state: evidence[0]?.state, checkpoint: evidence[0]?.checkpoint, target: evidence[0]?.target_kind }, { state: "dropped", checkpoint: "dropped", target: "local_filesystem" });
  assert.match(evidence[0]?.target_uri ?? "", /^file:\/\/\/tmp\/manifold-storage-seal-/);
});

test("real PG blocks missing or stale aggregate checkpoints before detach, then drops only after exact aggregate proof", async () => {
  pg.psql(`
    SELECT create_month_partition('observation', DATE '2026-03-01');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
      VALUES ('obs_truth_gate','${workspaceId}','trace-truth','inst-seal','public_app','route-seal','openai','ok',11,12,1,2,3,4,5,13,14,0,'2026-03-10T00:00:00Z','2026-03-10T00:00:00Z');
    UPDATE projection_checkpoint SET last_processed_at='2026-03-01T00:00:00Z'
      WHERE workspace_id='${workspaceId}' AND projection='usage_aggregate';
  `);
  await repository.aggregateClosedHour(workspaceId, new Date("2026-03-10T00:00:00Z"));
  const before = await pg.sql<{ requests: string; cache_write_tokens: string; audio_input_tokens: string; audio_output_tokens: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(cache_write_tokens)::text AS cache_write_tokens,
      sum(audio_input_tokens)::text AS audio_input_tokens, sum(audio_output_tokens)::text AS audio_output_tokens,
      sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain='hourly'
      AND bucket_start >= '2026-03-01T00:00:00Z' AND bucket_start < '2026-04-01T00:00:00Z'`;
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /checkpoint missing or stale for observation/);
  assert.equal((await pg.sql`SELECT to_regclass('public.observation_202603')::text AS relation`)[0]?.relation, "observation_202603", "failed proof must block DETACH as well as DROP");

  pg.psql(`UPDATE projection_checkpoint SET last_processed_at='2026-12-31T00:00:00Z'
    WHERE workspace_id='${workspaceId}' AND projection='usage_aggregate';`);
  const outcomes = await repository.compactEligiblePartitions(workspaceId);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.partitionName, "observation_202603");
  assert.equal((await pg.sql`SELECT to_regclass('public.observation_202603')::text AS relation`)[0]?.relation, null);
  const after = await pg.sql<{ requests: string; cache_write_tokens: string; audio_input_tokens: string; audio_output_tokens: string; cost: string }[]>`
    SELECT sum(requests)::text AS requests, sum(cache_write_tokens)::text AS cache_write_tokens,
      sum(audio_input_tokens)::text AS audio_input_tokens, sum(audio_output_tokens)::text AS audio_output_tokens,
      sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain='hourly'
      AND bucket_start >= '2026-03-01T00:00:00Z' AND bucket_start < '2026-04-01T00:00:00Z'`;
  assert.deepEqual(after, before, "proof and retention must never rewrite usage/cost totals");
});

test("real PG production rollups create checkpointed monthly cost truth before detail is dropped", async () => {
  pg.psql(`
    SELECT create_month_partition('observation', DATE '2026-04-01');
    SELECT create_month_partition('usage_record', DATE '2026-04-01');
    SELECT create_month_partition('cost_ledger', DATE '2026-04-01');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
      VALUES ('obs_cost_truth_gate','${workspaceId}','trace-cost-truth','inst-seal','public_app','route-seal','openai','ok',11,12,1,2,3,4,5,37,14,0,'2026-04-10T00:00:00Z','2026-04-10T00:00:00Z');
    INSERT INTO usage_record (id, workspace_id, observation_id, trace_id, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, fidelity, occurred_at, created_at)
      VALUES ('usage_cost_truth_gate','${workspaceId}','obs_cost_truth_gate','trace-cost-truth',11,12,1,2,3,4,5,'exact','2026-04-10T00:00:00Z','2026-04-10T00:00:00Z');
    INSERT INTO cost_ledger (id, workspace_id, observation_id, trace_id, amount_microusd, fidelity, occurred_at, created_at)
      VALUES ('cost_truth_gate','${workspaceId}','obs_cost_truth_gate','trace-cost-truth',37,'exact','2026-04-10T00:00:00Z','2026-04-10T00:00:00Z');
  `);
  await repository.aggregateClosedHour(workspaceId, new Date("2026-04-10T00:00:00Z"));
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /checkpoint missing or stale for cost_ledger/);
  assert.equal((await pg.sql`SELECT to_regclass('public.cost_ledger_202604')::text AS relation`)[0]?.relation, "cost_ledger_202604");

  await repository.rollupClosedWindows(workspaceId, new Date("2026-05-02T00:00:00Z"));
  const totalBefore = await pg.sql`SELECT sum(input_tokens)::text AS input, sum(output_tokens)::text AS output,
    sum(cache_write_tokens)::text AS cache_write, sum(audio_input_tokens)::text AS audio_input,
    sum(audio_output_tokens)::text AS audio_output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain='monthly' AND bucket_start='2026-04-01T00:00:00Z'`;
  assert.deepEqual(totalBefore[0], { input: "11", output: "12", cache_write: "3", audio_input: "4", audio_output: "5", cost: "37" });
  const outcomes = await repository.compactEligiblePartitions(workspaceId);
  assert.ok(outcomes.some((outcome) => outcome.partitionName === "cost_ledger_202604"));
  assert.equal((await pg.sql`SELECT to_regclass('public.cost_ledger_202604')::text AS relation`)[0]?.relation, null);
  const totalAfter = await pg.sql`SELECT sum(input_tokens)::text AS input, sum(output_tokens)::text AS output,
    sum(cache_write_tokens)::text AS cache_write, sum(audio_input_tokens)::text AS audio_input,
    sum(audio_output_tokens)::text AS audio_output, sum(cost_microusd)::text AS cost
    FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain='monthly' AND bucket_start='2026-04-01T00:00:00Z'`;
  assert.deepEqual(totalAfter, totalBefore, "dropping per-request cost detail cannot change monthly cost truth");
});

test("real PG persists each eight-object verification page and resumes only unverified chunks", async () => {
  const multipartPartition = "observation_202510";
  pg.psql(`
    UPDATE storage_retention_setting SET export_target='object_storage', export_location='s3://test-archive/retention' WHERE workspace_id='${workspaceId}';
    SELECT create_month_partition('observation', DATE '2025-10-01');
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    SELECT 'obs_multipart_' || n, '${workspaceId}', 'trace-multipart-' || n, 'inst-seal','public_app','route-seal','openai',
      'ok',1,1,0,0,0,0,0,1,1,0,
      '2025-10-10T00:00:00Z'::timestamptz + n * interval '1 microsecond',
      '2025-10-10T00:00:00Z'::timestamptz + n * interval '1 microsecond'
    FROM generate_series(1, 4501) AS n;
  `);
  await repository.aggregateClosedHour(workspaceId, new Date("2025-10-10T00:00:00Z"));
  pg.psql(`UPDATE projection_checkpoint SET last_processed_at='2026-12-31T00:00:00Z'
    WHERE workspace_id='${workspaceId}' AND projection='usage_aggregate';`);

  // Exactly one immutable chunk is appended per invocation: 9 full chunks plus one remainder.
  for (let number = 1; number <= 10; number += 1) {
    await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /storage chunk persisted/);
  }
  const beforeVerification = store.reverifiedUris.length;
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /verification page persisted/);
  const firstPage = await pg.sql<{ verified: number; pending: number }[]>`
    SELECT count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified,
      count(*) FILTER (WHERE verified_at IS NULL)::int AS pending
    FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${multipartPartition}`;
  assert.deepEqual([...firstPage], [{ verified: 8, pending: 2 }]);
  const firstPageUris = store.reverifiedUris.slice(beforeVerification);
  assert.equal(firstPageUris.filter((uri) => uri.includes(".chunk-")).length, 8);
  assert.equal(new Set(firstPageUris).size, 8, "a verification page must not reread the same immutable object");

  const outcomes = await repository.compactEligiblePartitions(workspaceId);
  assert.ok(outcomes.some((outcome) => outcome.partitionName === multipartPartition));
  const allChecks = store.reverifiedUris.slice(beforeVerification).filter((uri) => uri.includes(".chunk-"));
  assert.equal(allChecks.length, 10, "resume verifies the two pending chunks only");
  assert.equal(new Set(allChecks).size, 10, "persisted verified_at values are never reread on resume");
  const finalState = await pg.sql<{ verified: number; relation: string | null }[]>`
    SELECT (SELECT count(*) FILTER (WHERE verified_at IS NOT NULL)::int FROM storage_export_chunk
      WHERE workspace_id=${workspaceId} AND partition_name=${multipartPartition}) AS verified,
      to_regclass(${`public.${multipartPartition}`})::text AS relation`;
  assert.deepEqual([...finalState], [{ verified: 10, relation: null }]);
});

test("real PG bounds multipart exports by bytes, resumes the exact cursor, and fails closed for one oversized row", async () => {
  const byteBoundPartition = "observation_202512";
  const rowPayload = "x".repeat(Math.floor(MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES / 2) - 16_384);
  pg.psql(`
    UPDATE storage_retention_setting SET export_target='object_storage', export_location='s3://test-archive/retention' WHERE workspace_id='${workspaceId}';
    SELECT create_month_partition('observation', DATE '2025-12-01');
  `);
  for (const [id, offset] of [["obs_byte_1", 1], ["obs_byte_2", 2], ["obs_byte_3", 3]] as const) {
    await pg.sql`INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, capture_ref, final_provider,
      status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
      VALUES (${id}, ${workspaceId}, ${`trace-${id}`}, 'inst-seal', 'public_app', 'route-seal', ${JSON.stringify({ payload: rowPayload })}::jsonb, 'openai', 'ok', 1, 1, 0, 0, 0, 0, 0, 1, 1, 0,
        ${`2025-12-10T00:00:00.00000${offset}Z`}::timestamptz, ${`2025-12-10T00:00:00.00000${offset}Z`}::timestamptz)`;
  }
  await repository.aggregateClosedHour(workspaceId, new Date("2025-12-10T00:00:00Z"));
  pg.psql(`UPDATE projection_checkpoint SET last_processed_at='2026-12-31T00:00:00Z'
    WHERE workspace_id='${workspaceId}' AND projection='usage_aggregate';`);

  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /storage chunk persisted/);
  const firstChunk = await pg.sql<{ row_count: number; cursor_row_id: string }[]>`
    SELECT row_count::int, cursor_row_id FROM storage_export_chunk
    WHERE workspace_id=${workspaceId} AND partition_name=${byteBoundPartition} ORDER BY chunk_number`;
  assert.deepEqual([...firstChunk], [{ row_count: 2, cursor_row_id: "obs_byte_2" }]);
  const firstPayload = [...store.objects.entries()].find(([key]) => key.includes(byteBoundPartition) && key.includes(".chunk-1-"));
  assert.ok(firstPayload);
  assert.ok(gunzipSync(firstPayload[1]).length <= MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES);

  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /storage chunk persisted/);
  const chunkProofs = await pg.sql<{ chunk_number: number; row_count: number; cursor_row_id: string }[]>`
    SELECT chunk_number, row_count::int, cursor_row_id FROM storage_export_chunk
    WHERE workspace_id=${workspaceId} AND partition_name=${byteBoundPartition} ORDER BY chunk_number`;
  assert.deepEqual([...chunkProofs], [
    { chunk_number: 1, row_count: 2, cursor_row_id: "obs_byte_2" },
    { chunk_number: 2, row_count: 1, cursor_row_id: "obs_byte_3" },
  ]);
  const outcomes = await repository.compactEligiblePartitions(workspaceId);
  assert.ok(outcomes.some((outcome) => outcome.partitionName === byteBoundPartition));
  const byteBoundExport = [...store.objects.entries()]
    .filter(([key]) => key.includes(byteBoundPartition) && key.includes(".chunk-"))
    .map(([, bytes]) => gunzipSync(bytes).toString("utf8")).join("");
  assert.deepEqual(["obs_byte_1", "obs_byte_2", "obs_byte_3"].map((id) => (byteBoundExport.match(new RegExp(`\\"id\\":\\"${id}\\"`, "g")) ?? []).length), [1, 1, 1]);

  const oversizedPartition = "observation_202511";
  pg.psql(`SELECT create_month_partition('observation', DATE '2025-11-01');`);
  await pg.sql`INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, capture_ref, final_provider,
    status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, latency_ms, failovers, occurred_at, created_at)
    VALUES ('obs_oversized', ${workspaceId}, 'trace-oversized', 'inst-seal', 'public_app', 'route-seal', ${JSON.stringify({ payload: "y".repeat(MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES) })}::jsonb, 'openai', 'ok', 1, 1, 0, 0, 0, 0, 0, 1, 1, 0,
      '2025-11-10T00:00:00Z', '2025-11-10T00:00:00Z')`;
  await repository.aggregateClosedHour(workspaceId, new Date("2025-11-10T00:00:00Z"));
  await assert.rejects(() => repository.compactEligiblePartitions(workspaceId), /storage export row exceeds .* chunk limit/);
  assert.equal((await pg.sql`SELECT count(*)::int AS count FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${oversizedPartition}`)[0]?.count, 0);
  assert.equal((await pg.sql`SELECT to_regclass(${`public.${oversizedPartition}`})::text AS relation`)[0]?.relation, oversizedPartition,
    "an oversized row cannot create a partial proof or authorize its sealed partition to drop");
});
