import { getClient, setWorkspaceGuc, type Sql, type TransactionSql } from "@manifold/database";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";
import path from "node:path";
import {
  STORAGE_COMPACT_JOB_KIND,
  OBSERVATION_REDUCER_PROJECTION,
  MAX_DELETE_BATCH_ROWS,
  CompactionDeferred,
  MIN_COMPACTED_TRACE_RETENTION_DAYS,
  PartitionCompactionError,
  type CompactionBlocker,
  type CompactionJob,
  type CompactionProgress,
  type StorageRepository,
} from "./compactor.js";
import { S3ObjectStorageExporter, type ObjectStorageExporter, isValidObjectStorageLocation } from "./object-store.js";
import { effectiveCeilingBytes, forecastExhaustionAt, growthBytesPerDay, PRESSURE_GROWTH_SAMPLE_LIMIT, policyForStoragePressure, tierForStoragePressure, usedPct, type StoragePressurePolicy, type StoragePressureTier } from "./pressure-policy.js";

// This is deliberately smaller than the set of range-partitioned tables. A relation may be
// eligible for retention only when `assertTruthPreservationProof` can prove the durable truth
// that replaces it. In particular, policy decisions have no such projection today and remain
// fail-closed even though they are physically partitioned.
const RETENTION_PARENT_ALLOWLIST = new Set(["observation", "observation_event", "trace_summary", "policy_decision", "usage_record", "cost_ledger"]);
const HOURLY_DIMENSION_CAP = 10_000;
/** Bounds catch-up work per compactor run; another run resumes the ordered remainder. */
export const MAX_HOURLY_RECOMPUTE_WINDOWS = 1_000;
/**
 * A multipart export deliberately holds one JSONL payload and its gzip result in process memory.
 * Keep the uncompressed payload small enough that this remains safe in the Cron runtime; the
 * SQL keyset page also applies this limit before a JSON row crosses the database connection.
 */
export const MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
type RetentionSettings = {
  min_detail_hours: number;
  journal_retention_hours: number;
  capture_retention_hours: number;
  min_trace_days: number;
  observation_retention_days: number;
  cost_ledger_retention_days: number;
  policy_decision_retention_days: number;
  hourly_aggregate_retention_days: number;
  daily_aggregate_retention_days: number;
  export_target: string;
  export_location: string | null;
  enabled_at: string | null;
};
type RetentionClassSettings = Pick<RetentionSettings,
  "min_detail_hours" | "journal_retention_hours" | "min_trace_days" |
  "observation_retention_days" | "cost_ledger_retention_days" |
  "policy_decision_retention_days">;

/** Relation-specific authorization horizon. Unknown relations have no retention authority. */
export function retentionDurationMs(setting: RetentionClassSettings, relation: string): number {
  switch (relation) {
    case "observation_event":
      return Math.max(setting.journal_retention_hours, setting.min_detail_hours) * 3_600_000;
    case "observation":
    case "trace_summary":
    case "usage_record":
      return Math.max(setting.observation_retention_days, setting.min_trace_days) * 86_400_000;
    case "policy_decision":
      return Math.max(setting.policy_decision_retention_days, 90) * 86_400_000;
    case "cost_ledger":
      return Math.max(setting.cost_ledger_retention_days, setting.min_trace_days) * 86_400_000;
    default:
      throw new Error(`retention class unavailable for ${relation}`);
  }

}
type PartitionRow = { parent_name: string; partition_name: string; partition_bound: string; partition_oid: string };
type ManifestRow = { id: string; sha256: string; target_uri: string; row_count: string; byte_count: string };
type SealRow = { partition_name: string; source_relation: string; sealed_relation: string; relation_oid: string; partition_bound: string; range_start: Date | string; range_end: Date | string; seal_token: string; attempt_token: string; object_key: string; state: "sealed" | "export_verified" | "dropped"; export_manifest_id: string | null; exported_at: Date | string };
type ChunkProof = { chunk_number: number; cursor_created_at: string; cursor_row_id: string; row_count: string; target_uri: string; byte_count: string; sha256: string; uncompressed_sha256: string; verified_at?: string | null };

export type ColdExportManifest = Readonly<{
  schema: "manifold.storage-export-manifest.v1";
  window: { start: string; end: string };
  tables: readonly string[];
  row_counts: Record<string, number>;
  sha256: string;
  uncompressed_sha256?: string;
  byte_count: number;
  object_uri: string;
  exported_at: string;
}>;

/** Canonical, immutable companion object for an exported JSONL partition. */
export function buildColdExportManifest(input: {
  sourceRelation: string;
  start: Date;
  end: Date;
  rowCount: number;
  byteCount: number;
  sha256: string;
  uncompressedSha256?: string;
  objectUri: string;
  exportedAt: string;
}): { bytes: Buffer; sha256: string } {
  const manifest: ColdExportManifest = {
    schema: "manifold.storage-export-manifest.v1",
    window: { start: input.start.toISOString(), end: input.end.toISOString() },
    tables: [input.sourceRelation],
    row_counts: { [input.sourceRelation]: input.rowCount },
    sha256: input.sha256,
    ...(input.uncompressedSha256 ? { uncompressed_sha256: input.uncompressedSha256 } : {}),
    byte_count: input.byteCount,
    object_uri: input.objectUri,
    exported_at: input.exportedAt,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function safeIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error("unsafe retention relation identifier");
  return `"${value}"`;
}

function rangeEnd(bound: string): Date | null {
  const match = bound.match(/TO \('([^']+)'\)/);
  if (!match) return null;
  const value = new Date(match[1]!);
  return Number.isNaN(value.valueOf()) ? null : value;
}

function rangeStart(bound: string): Date | null {
  const match = bound.match(/FROM \('([^']+)'\)/);
  if (!match) return null;
  const value = new Date(match[1]!);
  return Number.isNaN(value.valueOf()) ? null : value;
}

type JobRow = { id: string; workspace_id: string; payload: unknown; status: CompactionJob["status"] };
type StorageWorkspaceRow = { storage_ceiling_bytes: string; storage_warn_pct: number; storage_high_pct: number; storage_crit_pct: number };

export type StoragePressureMeasurement = Readonly<{
  workspaceId: string;
  measuredAt: Date;
  totalBytes: number;
  tableBytes: Record<string, number>;
  heapBytes: number;
  indexBytes: number;
  toastBytes: number;
  configuredCeilingBytes: number;
  effectiveCeilingBytes: number;
  usedPct: number;
  growthBytesPerDay: number | null;
  forecastExhaustionAt: Date | null;
  tier: StoragePressureTier;
  policy: StoragePressurePolicy;
  transitioned: boolean;
  compactionJobId: string | null;
}>;

/** Direct-only repository. The client is max:1 and must be closed after every worker invocation. */
export class PostgresStorageRepository implements StorageRepository {
  constructor(private readonly sql: Sql, private readonly objectStorage: ObjectStorageExporter = new S3ObjectStorageExporter()) {}

  async tryLock(workspaceId: string, deadline?: number): Promise<boolean> {
    return this.withDeadline(deadline, async () => {
    const rows = await this.sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext('compact:' || ${workspaceId})) AS acquired`;
    return rows[0]?.acquired === true;
    });
  }

  async claim(jobId: string, workspaceId: string, workerId: string, deadline?: number): Promise<CompactionJob | null> {
    return this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      const rows = await tx<JobRow[]>`
        UPDATE job_ledger
        SET status = 'claimed', claimed_by = ${workerId}, claimed_at = now(), updated_at = now()
        WHERE id = ${jobId} AND workspace_id = ${workspaceId} AND kind = ${STORAGE_COMPACT_JOB_KIND}
          AND status IN ('pending', 'claimed')
        RETURNING id, workspace_id, payload, status`;
      const row = rows[0];
      return row ? { id: row.id, workspaceId: row.workspace_id, payload: row.payload, status: row.status } : null;
    }) as Promise<CompactionJob | null>);
  }

  async measure(deadline?: number): Promise<number> {
    // Relation-size scans can block behind catalog work. Run them in a bounded transaction so
    // the scheduler deadline reaches PostgreSQL rather than merely rejecting after the query.
    return this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      const rows = await tx<{ bytes: string }[]>`
        SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint::text AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'p')`;
      return Number(rows[0]?.bytes ?? 0);
    }));
  }

  async listUncheckpointedClosedHours(workspaceId: string, now: Date, limit = MAX_HOURLY_RECOMPUTE_WINDOWS, deadline?: number): Promise<readonly Date[]> {
    const closedBefore = new Date(now);
    closedBefore.setUTCMinutes(0, 0, 0);
    return this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      const rows = await tx<{ bucket: Date }[]>`
        WITH source AS (
          SELECT date_trunc('hour', o.occurred_at) AS bucket,
            count(*)::bigint AS requests,
            coalesce(sum(o.input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(o.output_tokens),0)::bigint AS output_tokens,
            coalesce(sum(o.cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(o.reasoning_tokens),0)::bigint AS reasoning_tokens,
            coalesce(sum(o.cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(o.audio_input_tokens),0)::bigint AS audio_input_tokens,
            coalesce(sum(o.audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(o.cost_microusd),0)::bigint AS cost_microusd,
            count(*) FILTER (WHERE o.status='error')::bigint AS errors,
            coalesce(sum(o.failovers),0)::bigint AS failovers,
            coalesce(sum(o.latency_ms),0)::bigint AS latency_ms_sum
        FROM observation o
        WHERE o.workspace_id = ${workspaceId}
          AND o.occurred_at < ${closedBefore}
          GROUP BY date_trunc('hour', o.occurred_at)
        )
        SELECT s.bucket
        FROM source s
        LEFT JOIN storage_rollup_checkpoint c
          ON c.workspace_id=${workspaceId} AND c.target_grain='hourly'
          AND c.bucket_start=s.bucket
        WHERE c.bucket_start IS NULL
          OR c.exact_totals IS DISTINCT FROM (to_jsonb(s) - 'bucket')
        ORDER BY s.bucket
        LIMIT ${Math.min(Math.max(limit, 1), MAX_HOURLY_RECOMPUTE_WINDOWS)}`;
      return rows.map(({ bucket }) => new Date(bucket));
    }));
  }

  /**
   * The sole durable pressure-action seam. It writes the measurement and current capture/journal
   * policy together, then emits at most one row for each non-normal tier for a workspace. This
   * state is intentionally not consulted by the provider gateway.
   */
  async measurePressure(workspaceId: string, measuredAt = new Date()): Promise<StoragePressureMeasurement> {
    const catalog = await this.sql<{ relation: string; total_bytes: string; heap_bytes: string; index_bytes: string; toast_bytes: string }[]>`
      SELECT c.relname AS relation,
        pg_total_relation_size(c.oid)::bigint::text AS total_bytes,
        pg_relation_size(c.oid)::bigint::text AS heap_bytes,
        pg_indexes_size(c.oid)::bigint::text AS index_bytes,
        coalesce(pg_total_relation_size(c.reltoastrelid), 0)::bigint::text AS toast_bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm', 'p')
      ORDER BY c.relname`;
    const tableBytes = Object.fromEntries(catalog.map((row) => [row.relation, Number(row.total_bytes)]));
    const totalBytes = Object.values(tableBytes).reduce((sum, bytes) => sum + bytes, 0);
    const heapBytes = catalog.reduce((sum, row) => sum + Number(row.heap_bytes), 0);
    const indexBytes = catalog.reduce((sum, row) => sum + Number(row.index_bytes), 0);
    const toastBytes = catalog.reduce((sum, row) => sum + Number(row.toast_bytes), 0);

    return this.sql.begin(async (tx) => {
      await setWorkspaceGuc(tx, workspaceId);
      const workspace = (await tx<StorageWorkspaceRow[]>`
        SELECT storage_ceiling_bytes::text, storage_warn_pct, storage_high_pct, storage_crit_pct
        FROM workspace WHERE id = ${workspaceId} LIMIT 1`)[0];
      if (!workspace) throw new Error("workspace not found for storage pressure measurement");
      const configuredCeilingBytes = Number(workspace.storage_ceiling_bytes);
      const effectiveCeiling = effectiveCeilingBytes({ ceilingBytes: configuredCeilingBytes, indexBytes, heapBytes });
      const percentage = usedPct(totalBytes, effectiveCeiling);
      const tier = tierForStoragePressure({ usedPct: percentage, warnPct: workspace.storage_warn_pct, highPct: workspace.storage_high_pct, critPct: workspace.storage_crit_pct });
      const policy = policyForStoragePressure(tier);
      const recent = await tx<{ measured_at: Date | string; total_bytes: string }[]>`
        SELECT measured_at, total_bytes::text
        FROM storage_stat
        WHERE workspace_id = ${workspaceId}
        ORDER BY measured_at DESC
        LIMIT ${PRESSURE_GROWTH_SAMPLE_LIMIT - 1}`;
      const growth = growthBytesPerDay([
        ...recent.reverse().map((sample) => ({ measuredAt: new Date(sample.measured_at), totalBytes: Number(sample.total_bytes) })),
        { measuredAt, totalBytes },
      ]);
      const forecast = forecastExhaustionAt({ measuredAt, totalBytes, effectiveCeilingBytes: effectiveCeiling, growthBytesPerDay: growth });
      const prior = (await tx<{ tier: StoragePressureTier }[]>`SELECT tier FROM storage_pressure_state WHERE workspace_id = ${workspaceId} LIMIT 1`)[0] ?? null;
      const transitioned = prior?.tier !== tier;

      await tx`
        INSERT INTO storage_stat (id, workspace_id, measured_at, total_bytes, table_bytes, index_bytes, toast_bytes,
          ceiling_bytes, effective_ceiling_bytes, used_pct, growth_bytes_per_day, forecast_exhaustion_at, tier)
        VALUES (${'sst_' + randomUUID()}, ${workspaceId}, ${measuredAt}, ${totalBytes}, ${tx.json(tableBytes as never)},
          ${indexBytes}, ${toastBytes}, ${configuredCeilingBytes}, ${effectiveCeiling}, ${percentage},
          ${growth === null ? null : Math.round(growth)}, ${forecast}, ${tier})`;
      await tx`
        INSERT INTO storage_pressure_state (workspace_id, tier, capture_mode, payload_sample_rate, journal_mode,
          trigger_compaction, compact_every_measure, block_non_essential_growth, measured_at, updated_at)
        VALUES (${workspaceId}, ${tier}, ${policy.captureMode}, ${policy.payloadSampleRate}, ${policy.journalMode},
          ${policy.triggerCompaction}, ${policy.compactEveryMeasure}, ${policy.blockNonEssentialGrowth}, ${measuredAt}, now())
        ON CONFLICT (workspace_id) DO UPDATE SET tier = EXCLUDED.tier, capture_mode = EXCLUDED.capture_mode,
          payload_sample_rate = EXCLUDED.payload_sample_rate, journal_mode = EXCLUDED.journal_mode,
          trigger_compaction = EXCLUDED.trigger_compaction, compact_every_measure = EXCLUDED.compact_every_measure,
          block_non_essential_growth = EXCLUDED.block_non_essential_growth, measured_at = EXCLUDED.measured_at,
          updated_at = now()`;

      // Only pressure transitions create/update pressure alerts. A normal recovery resolves the
      // bounded active pressure set; the independent near-term forecast alert is handled below.
      if (transitioned) {
        await tx`UPDATE storage_pressure_alert SET resolved_at = ${measuredAt}, updated_at = now()
          WHERE workspace_id = ${workspaceId} AND resolved_at IS NULL AND tier <> ${tier}
            AND tier <> 'forecast_exhaustion_14d'`;
        if (tier !== "normal") await tx`
          INSERT INTO storage_pressure_alert (workspace_id, tier, opened_at, last_transition_at, resolved_at, transition_count, updated_at)
          VALUES (${workspaceId}, ${tier}, ${measuredAt}, ${measuredAt}, NULL, 1, now())
          ON CONFLICT (workspace_id, tier) DO UPDATE SET last_transition_at = EXCLUDED.last_transition_at,
            resolved_at = NULL, transition_count = storage_pressure_alert.transition_count + 1, updated_at = now()`;
      }

      const forecastImminent = forecast !== null && forecast.getTime() <= measuredAt.getTime() + 14 * 24 * 60 * 60 * 1_000;
      if (forecastImminent) {
        await tx`INSERT INTO storage_pressure_alert (workspace_id, tier, opened_at, last_transition_at, resolved_at, transition_count, updated_at)
          VALUES (${workspaceId}, 'forecast_exhaustion_14d', ${measuredAt}, ${measuredAt}, NULL, 1, now())
          ON CONFLICT (workspace_id, tier) DO UPDATE SET
            last_transition_at = CASE WHEN storage_pressure_alert.resolved_at IS NOT NULL THEN EXCLUDED.last_transition_at ELSE storage_pressure_alert.last_transition_at END,
            resolved_at = NULL,
            transition_count = storage_pressure_alert.transition_count + CASE WHEN storage_pressure_alert.resolved_at IS NOT NULL THEN 1 ELSE 0 END,
            updated_at = now()`;
      } else {
        await tx`UPDATE storage_pressure_alert SET resolved_at = ${measuredAt}, updated_at = now()
          WHERE workspace_id = ${workspaceId} AND tier = 'forecast_exhaustion_14d' AND resolved_at IS NULL`;
      }

      let compactionJobId: string | null = null;
      if (policy.triggerCompaction && (transitioned || policy.compactEveryMeasure)) {
        compactionJobId = `job_storage_pressure_${randomUUID()}`;
        await tx`INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key)
          VALUES (${compactionJobId}, ${workspaceId}, ${STORAGE_COMPACT_JOB_KIND},
            ${tx.json({ pressure: { tier, measuredAt: measuredAt.toISOString() } } as never)},
            ${`storage-pressure:${workspaceId}:${measuredAt.toISOString()}`})`;
      }
      return { workspaceId, measuredAt, totalBytes, tableBytes, heapBytes, indexBytes, toastBytes,
        configuredCeilingBytes, effectiveCeilingBytes: effectiveCeiling, usedPct: percentage,
        growthBytesPerDay: growth === null ? null : Math.round(growth), forecastExhaustionAt: forecast, tier, policy,
        transitioned, compactionJobId };
    });
  }

  async aggregateClosedHour(workspaceId: string, closedHour: Date, deadline?: number): Promise<void> {
    const end = new Date(closedHour.getTime() + 60 * 60 * 1_000);
    await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      // A bucket is exact replacement, including removal of groups that disappeared on retry.
      await tx`DELETE FROM usage_aggregate
        WHERE workspace_id=${workspaceId} AND grain='hourly' AND bucket_start=${closedHour}`;
      await tx`
        WITH base AS (
          SELECT o.*,
            jsonb_build_object('route_id', o.route_id, 'provider', o.final_provider,
              'offering_id', o.final_offering_id, 'app_id', o.app_id, 'team_id', o.team_id,
              'cost_center_id', o.cost_center_id, 'status', o.status) AS source_dims,
            md5(jsonb_build_array(o.route_id, o.final_provider, o.final_offering_id, o.app_id,
              o.team_id, o.cost_center_id, o.status)::text) AS source_hash
          FROM observation o
          WHERE o.workspace_id = ${workspaceId}
            AND o.occurred_at >= ${closedHour} AND o.occurred_at < ${end}
        ), ranked_dims AS (
          SELECT source_hash, row_number() OVER (ORDER BY source_hash) AS dimension_rank
          FROM (SELECT DISTINCT source_hash FROM base) dimensions
        ), bounded AS (
          SELECT b.*,
            CASE WHEN r.dimension_rank < ${HOURLY_DIMENSION_CAP}
              THEN b.source_dims ELSE jsonb_build_object('overflow', true) END AS bounded_dims,
            CASE WHEN r.dimension_rank < ${HOURLY_DIMENSION_CAP}
              THEN b.source_hash ELSE md5('manifold:usage-aggregate:overflow') END AS bounded_hash
          FROM base b JOIN ranked_dims r USING (source_hash)
        )
        INSERT INTO usage_aggregate (
          workspace_id, grain, bucket_start, dims, dims_hash, requests, input_tokens,
          output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens,
          audio_output_tokens, cost_microusd, errors, failovers,
          latency_ms_sum, latency_ms_p95, updated_at
        )
        SELECT
          workspace_id, 'hourly', ${closedHour}, bounded_dims, bounded_hash,
          count(*)::bigint, coalesce(sum(input_tokens), 0)::bigint, coalesce(sum(output_tokens), 0)::bigint,
          coalesce(sum(cache_read_tokens), 0)::bigint, coalesce(sum(reasoning_tokens), 0)::bigint,
          coalesce(sum(cache_write_tokens), 0)::bigint, coalesce(sum(audio_input_tokens), 0)::bigint,
          coalesce(sum(audio_output_tokens), 0)::bigint, coalesce(sum(cost_microusd), 0)::bigint,
          count(*) FILTER (WHERE status = 'error')::bigint, coalesce(sum(failovers), 0)::bigint,
          coalesce(sum(latency_ms), 0)::bigint,
          percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int, now()
        FROM bounded
        GROUP BY workspace_id, bounded_dims, bounded_hash`;
      await this.writeRollupCheckpoint(tx, workspaceId, "observation", "hourly", closedHour, end);
      // This is durable coverage evidence, not a best-effort metric. A later retry may advance
      // it but can never move it backwards and authorize a stale retention window.
      await tx`INSERT INTO projection_checkpoint (workspace_id, projection, last_processed_at, updated_at)
        VALUES (${workspaceId}, 'usage_aggregate', ${end}, now())
        ON CONFLICT (workspace_id, projection) DO UPDATE SET
          last_processed_at = greatest(projection_checkpoint.last_processed_at, EXCLUDED.last_processed_at),
          updated_at = now()`;
    }));
  }

  private async writeRollupCheckpoint(
    tx: TransactionSql,
    workspaceId: string,
    sourceGrain: "observation" | "hourly" | "daily",
    targetGrain: "hourly" | "daily" | "monthly",
    bucket: Date,
    end: Date,
  ): Promise<void> {
    const source = sourceGrain === "observation"
      ? tx`SELECT count(*)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
          coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
          coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
          coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
          coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, count(*) FILTER (WHERE status='error')::bigint AS errors,
          coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms),0)::bigint AS latency_ms_sum
        FROM observation WHERE workspace_id=${workspaceId} AND occurred_at >= ${bucket} AND occurred_at < ${end}`
      : tx`SELECT coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
          coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
          coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
          coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
          coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
          coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
        FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${sourceGrain}
          AND bucket_start >= ${bucket} AND bucket_start < ${end}`;
    const target = tx`SELECT coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
        coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
        coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
        coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
        coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
        coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
      FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${targetGrain}
        AND bucket_start >= ${bucket} AND bucket_start < ${end}`;
    const proof = await tx<{ exact: boolean; totals: unknown }[]>`
      WITH source AS (${source}), target AS (${target})
      SELECT to_jsonb(source) = to_jsonb(target) AS exact, to_jsonb(target) AS totals
      FROM source CROSS JOIN target`;
    if (!proof[0]?.exact) throw new Error(`rollup exact-sum proof failed for ${targetGrain} ${bucket.toISOString()}`);
    await tx`INSERT INTO storage_rollup_checkpoint
        (workspace_id, source_grain, target_grain, bucket_start, bucket_end, exact_totals, completed_at)
      VALUES (${workspaceId}, ${sourceGrain}, ${targetGrain}, ${bucket}, ${end}, ${tx.json(proof[0].totals as never)}, now())
      ON CONFLICT (workspace_id, target_grain, bucket_start) DO UPDATE SET
        source_grain=EXCLUDED.source_grain, bucket_end=EXCLUDED.bucket_end,
        exact_totals=EXCLUDED.exact_totals, completed_at=now()`;
  }

  /** Fold every fully closed bucket, including backfilled windows, without ever advancing a
   * coverage checkpoint past aggregates that were actually written. */
  async rollupClosedWindows(workspaceId: string, now: Date, deadline?: number): Promise<void> {
    const ensureTime = () => this.throwIfDeadline(deadline);
    ensureTime();
    const closedDay = new Date(now); closedDay.setUTCHours(0, 0, 0, 0);
    const days = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      return tx<{ bucket: Date }[]>`SELECT DISTINCT date_trunc('day', bucket_start) AS bucket
        FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain='hourly' AND bucket_start < ${closedDay}
        ORDER BY bucket LIMIT 64`;
    }));
    for (const { bucket } of days) { ensureTime(); await this.rollupBucket(workspaceId, "daily", new Date(bucket), deadline); }

    const closedMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const months = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      return tx<{ bucket: Date }[]>`SELECT DISTINCT date_trunc('month', bucket_start) AS bucket
        FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain='daily' AND bucket_start < ${closedMonth}
        ORDER BY bucket LIMIT 64`;
    }));
    for (const { bucket } of months) { ensureTime(); await this.rollupBucket(workspaceId, "monthly", new Date(bucket), deadline); }
  }

  /** One short, exact-replacement rollup transaction. Daily/monthly deliberately collapse
   * offering and cost-center identity, as §13.4 requires, while retaining exact sums.
   *
   * Source retention may remove sibling buckets after their target was proven. A later source
   * bucket must therefore replace only its own durable contribution, never reconstruct a target
   * from the surviving source rows alone. `storage_rollup_source_checkpoint` is that proof.
   *
   * 0030 intentionally begins empty on an existing database.  A legacy checkpoint can establish
   * its baseline only while the complete retained source and existing target both still exactly
   * equal its recorded totals; otherwise this fails before deleting any target truth. */
  private async rollupBucket(workspaceId: string, targetGrain: "daily" | "monthly", bucket: Date, deadline?: number): Promise<void> {
    const sourceGrain = targetGrain === "daily" ? "hourly" : "daily";
    const end = targetGrain === "daily"
      ? new Date(bucket.getTime() + 86_400_000)
      : new Date(Date.UTC(bucket.getUTCFullYear(), bucket.getUTCMonth() + 1, 1));
    await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      const prior = (await tx<{ exists: boolean; snapshots: number; baseline_exact: boolean }[]>`
        WITH checkpoint AS (
          SELECT exact_totals FROM storage_rollup_checkpoint
          WHERE workspace_id=${workspaceId} AND source_grain=${sourceGrain}
            AND target_grain=${targetGrain} AND bucket_start=${bucket}
        ), source_totals AS (
          SELECT coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${sourceGrain}
            AND bucket_start >= ${bucket} AND bucket_start < ${end}
        ), target_totals AS (
          SELECT coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${targetGrain} AND bucket_start=${bucket}
        ), source_contributions AS (
          SELECT jsonb_build_object('route_id', NULL, 'provider', dims->>'provider', 'offering_id', NULL,
              'app_id', dims->>'app_id', 'team_id', dims->>'team_id', 'cost_center_id', NULL,
              'status', dims->>'status') AS dims,
            md5(jsonb_build_array(dims->>'provider', dims->>'app_id', dims->>'team_id', dims->>'status')::text) AS dims_hash,
            coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${sourceGrain}
            AND bucket_start >= ${bucket} AND bucket_start < ${end}
          GROUP BY dims
        ), source_signature AS (
          SELECT coalesce(jsonb_agg(to_jsonb(source_contributions) ORDER BY dims_hash), '[]'::jsonb) AS rows
          FROM source_contributions
        ), target_contributions AS (
          SELECT dims, dims_hash, requests, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
            cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, errors, failovers, latency_ms_sum
          FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${targetGrain} AND bucket_start=${bucket}
        ), target_signature AS (
          SELECT coalesce(jsonb_agg(to_jsonb(target_contributions) ORDER BY dims_hash), '[]'::jsonb) AS rows
          FROM target_contributions
        )
        SELECT EXISTS(SELECT 1 FROM checkpoint) AS exists,
          (SELECT count(*)::int FROM storage_rollup_source_checkpoint
            WHERE workspace_id=${workspaceId} AND source_grain=${sourceGrain}
              AND target_grain=${targetGrain} AND bucket_start=${bucket}) AS snapshots,
          coalesce((SELECT to_jsonb(source_totals) = checkpoint.exact_totals
              AND to_jsonb(target_totals) = checkpoint.exact_totals
              AND source_signature.rows = target_signature.rows
            FROM checkpoint CROSS JOIN source_totals CROSS JOIN target_totals
              CROSS JOIN source_signature CROSS JOIN target_signature), false) AS baseline_exact`)[0];
      if (prior?.exists && prior.snapshots === 0 && !prior.baseline_exact) {
        throw new Error(`rollup source proof missing or incomplete for ${targetGrain} ${bucket.toISOString()}`);
      }
      await tx`DELETE FROM usage_aggregate
        WHERE workspace_id=${workspaceId} AND grain=${targetGrain} AND bucket_start=${bucket}`;
      await tx`
        WITH current_source AS (
          SELECT bucket_start AS source_bucket_start,
            jsonb_build_object('route_id', NULL, 'provider', dims->>'provider', 'offering_id', NULL,
              'app_id', dims->>'app_id', 'team_id', dims->>'team_id', 'cost_center_id', NULL,
              'status', dims->>'status') AS dims,
            coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM usage_aggregate
          WHERE workspace_id=${workspaceId} AND grain=${sourceGrain} AND bucket_start >= ${bucket} AND bucket_start < ${end}
          GROUP BY bucket_start, dims
        ), normalized_current AS (
          SELECT source_bucket_start, dims,
            md5(jsonb_build_array(dims->>'provider', dims->>'app_id', dims->>'team_id', dims->>'status')::text) AS dims_hash,
            requests, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens,
            audio_input_tokens, audio_output_tokens, cost_microusd, errors, failovers, latency_ms_sum
          FROM current_source
        ), retained_snapshot AS (
          SELECT source_bucket_start, dims, dims_hash, requests, input_tokens, output_tokens,
            cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
            cost_microusd, errors, failovers, latency_ms_sum
          FROM storage_rollup_source_checkpoint
          WHERE workspace_id=${workspaceId} AND source_grain=${sourceGrain}
            AND target_grain=${targetGrain} AND bucket_start=${bucket}
            AND source_bucket_start NOT IN (SELECT DISTINCT source_bucket_start FROM normalized_current)
        ), normalized AS (
          SELECT * FROM retained_snapshot UNION ALL SELECT * FROM normalized_current
        )
        INSERT INTO usage_aggregate (
          workspace_id, grain, bucket_start, dims, dims_hash, requests, input_tokens, output_tokens,
          cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
          cost_microusd, errors, failovers, latency_ms_sum, latency_ms_p95, updated_at
        )
        SELECT ${workspaceId}, ${targetGrain}, ${bucket}, dims,
          md5(jsonb_build_array(dims->>'provider', dims->>'app_id', dims->>'team_id', dims->>'status')::text),
          coalesce(sum(requests), 0)::bigint, coalesce(sum(input_tokens), 0)::bigint,
          coalesce(sum(output_tokens), 0)::bigint, coalesce(sum(cache_read_tokens), 0)::bigint,
          coalesce(sum(reasoning_tokens), 0)::bigint, coalesce(sum(cache_write_tokens), 0)::bigint,
          coalesce(sum(audio_input_tokens), 0)::bigint, coalesce(sum(audio_output_tokens), 0)::bigint,
          coalesce(sum(cost_microusd), 0)::bigint, coalesce(sum(errors), 0)::bigint,
          coalesce(sum(failovers), 0)::bigint, coalesce(sum(latency_ms_sum), 0)::bigint,
          NULL::int, now()
        FROM normalized GROUP BY dims, dims_hash
        `;
      const proof = (await tx<{ exact: boolean; totals: unknown }[]>`
        WITH current_source AS (
          SELECT bucket_start AS source_bucket_start,
            jsonb_build_object('route_id', NULL, 'provider', dims->>'provider', 'offering_id', NULL,
              'app_id', dims->>'app_id', 'team_id', dims->>'team_id', 'cost_center_id', NULL,
              'status', dims->>'status') AS dims,
            coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${sourceGrain}
            AND bucket_start >= ${bucket} AND bucket_start < ${end}
          GROUP BY bucket_start, dims
        ), normalized_current AS (
          SELECT source_bucket_start, dims,
            md5(jsonb_build_array(dims->>'provider', dims->>'app_id', dims->>'team_id', dims->>'status')::text) AS dims_hash,
            requests, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens,
            audio_input_tokens, audio_output_tokens, cost_microusd, errors, failovers, latency_ms_sum
          FROM current_source
        ), retained_snapshot AS (
          SELECT source_bucket_start, dims, dims_hash, requests, input_tokens, output_tokens,
            cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens,
            cost_microusd, errors, failovers, latency_ms_sum
          FROM storage_rollup_source_checkpoint
          WHERE workspace_id=${workspaceId} AND source_grain=${sourceGrain}
            AND target_grain=${targetGrain} AND bucket_start=${bucket}
            AND source_bucket_start NOT IN (SELECT DISTINCT source_bucket_start FROM normalized_current)
        ), normalized AS (
          SELECT * FROM retained_snapshot UNION ALL SELECT * FROM normalized_current
        ), source_totals AS (
          SELECT coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM normalized
        ), target_totals AS (
          SELECT coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${targetGrain} AND bucket_start=${bucket}
        )
        SELECT to_jsonb(source_totals) = to_jsonb(target_totals) AS exact, to_jsonb(target_totals) AS totals
        FROM source_totals CROSS JOIN target_totals`)[0];
      if (!proof?.exact) throw new Error(`rollup durable-source proof failed for ${targetGrain} ${bucket.toISOString()}`);
      await tx`DELETE FROM storage_rollup_source_checkpoint
        WHERE workspace_id=${workspaceId} AND source_grain=${sourceGrain}
          AND target_grain=${targetGrain} AND bucket_start=${bucket}
          AND source_bucket_start IN (
            SELECT DISTINCT bucket_start FROM usage_aggregate
            WHERE workspace_id=${workspaceId} AND grain=${sourceGrain} AND bucket_start >= ${bucket} AND bucket_start < ${end}
          )`;
      await tx`
        WITH current_source AS (
          SELECT bucket_start AS source_bucket_start,
            jsonb_build_object('route_id', NULL, 'provider', dims->>'provider', 'offering_id', NULL,
              'app_id', dims->>'app_id', 'team_id', dims->>'team_id', 'cost_center_id', NULL,
              'status', dims->>'status') AS dims,
            coalesce(sum(requests),0)::bigint AS requests, coalesce(sum(input_tokens),0)::bigint AS input_tokens,
            coalesce(sum(output_tokens),0)::bigint AS output_tokens, coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
            coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens, coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
            coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens, coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
            coalesce(sum(cost_microusd),0)::bigint AS cost_microusd, coalesce(sum(errors),0)::bigint AS errors,
            coalesce(sum(failovers),0)::bigint AS failovers, coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
          FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${sourceGrain}
            AND bucket_start >= ${bucket} AND bucket_start < ${end}
          GROUP BY bucket_start, dims
        )
        INSERT INTO storage_rollup_source_checkpoint (
          workspace_id, source_grain, target_grain, bucket_start, source_bucket_start, dims, dims_hash,
          requests, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens,
          audio_input_tokens, audio_output_tokens, cost_microusd, errors, failovers, latency_ms_sum, completed_at
        )
        SELECT ${workspaceId}, ${sourceGrain}, ${targetGrain}, ${bucket}, source_bucket_start, dims,
          md5(jsonb_build_array(dims->>'provider', dims->>'app_id', dims->>'team_id', dims->>'status')::text),
          requests, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens,
          audio_input_tokens, audio_output_tokens, cost_microusd, errors, failovers, latency_ms_sum, now()
        FROM current_source`;
      await tx`INSERT INTO storage_rollup_checkpoint
        (workspace_id, source_grain, target_grain, bucket_start, bucket_end, exact_totals, completed_at)
        VALUES (${workspaceId}, ${sourceGrain}, ${targetGrain}, ${bucket}, ${end}, ${tx.json(proof.totals as never)}, now())
        ON CONFLICT (workspace_id, target_grain, bucket_start) DO UPDATE SET
          source_grain=EXCLUDED.source_grain, bucket_end=EXCLUDED.bucket_end,
          exact_totals=EXCLUDED.exact_totals, completed_at=now()`;
      await tx`INSERT INTO projection_checkpoint (workspace_id, projection, last_processed_at, updated_at)
        VALUES (${workspaceId}, ${`usage_aggregate_${targetGrain}`}, ${end}, now())
        ON CONFLICT (workspace_id, projection) DO UPDATE SET
          last_processed_at=greatest(projection_checkpoint.last_processed_at, EXCLUDED.last_processed_at), updated_at=now()`;
      await tx`INSERT INTO projection_checkpoint (workspace_id, projection, last_processed_at, updated_at)
        VALUES (${workspaceId}, 'usage_aggregate', ${end}, now())
        ON CONFLICT (workspace_id, projection) DO UPDATE SET
          last_processed_at=greatest(projection_checkpoint.last_processed_at, EXCLUDED.last_processed_at), updated_at=now()`;
    }));
  }

  async retentionPrerequisites(workspaceId: string, deadline?: number): Promise<readonly string[]> {
    return this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      const setting = (await tx<RetentionSettings[]>`SELECT *
        FROM storage_retention_setting WHERE workspace_id = ${workspaceId} LIMIT 1`)[0];
      const missing: string[] = [];
      if (!setting?.enabled_at) missing.push("retention_settings");
      if (!setting || setting.export_target === "disabled") missing.push("export_target");
      if (setting?.export_target === "object_storage") {
        if (!isValidObjectStorageLocation(setting.export_location)) missing.push("object_storage_location");
        if (!this.objectStorage.configured()) missing.push(`object_storage_configuration:${this.objectStorage.configurationError() ?? "unavailable"}`);
      }
      if (setting?.export_target === "local_filesystem") {
        if (process.env.NODE_ENV === "production") missing.push("local_export_forbidden_in_production");
        if (!setting.export_location || !path.isAbsolute(setting.export_location)) missing.push("local_export_location");
      }
      return missing;
    }));
  }

  async pruneExpiredCaptures(workspaceId: string, now: Date, maxBatches = Number.MAX_SAFE_INTEGER, deadline?: number): Promise<number> {
    let pruned = 0;
    for (let batches = 0; batches < maxBatches; batches += 1) {
      const rows = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
        await this.setTransactionDeadline(tx, deadline);
        await setWorkspaceGuc(tx, workspaceId);
        return tx<{ id: string }[]>`
          WITH settings AS (
            SELECT capture_retention_hours FROM storage_retention_setting
            WHERE workspace_id=${workspaceId} AND enabled_at IS NOT NULL
          ), candidates AS (
            SELECT o.tableoid, o.ctid FROM observation o CROSS JOIN settings s
            WHERE o.workspace_id=${workspaceId} AND o.capture_ref IS NOT NULL
              AND o.occurred_at < ${now} - (s.capture_retention_hours * interval '1 hour')
            ORDER BY o.occurred_at, o.id
            LIMIT ${MAX_DELETE_BATCH_ROWS}
          )
          UPDATE observation o SET capture_ref=NULL
          FROM candidates c WHERE o.tableoid=c.tableoid AND o.ctid=c.ctid
          RETURNING o.id`;
      }));
      pruned += rows.length;
      if (rows.length < MAX_DELETE_BATCH_ROWS) break;
    }
    return pruned;
  }

  async pruneExpiredAggregateGrains(workspaceId: string, now: Date, maxBatches = Number.MAX_SAFE_INTEGER, deadline?: number): Promise<number> {
    let pruned = 0;
    let batches = 0;
    for (const sourceGrain of ["hourly", "daily"] as const) {
      const targetGrain = sourceGrain === "hourly" ? "daily" : "monthly";
      const cutoffColumn = sourceGrain === "hourly"
        ? "hourly_aggregate_retention_days"
        : "daily_aggregate_retention_days";
      for (; batches < maxBatches; batches += 1) {
        const rows = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
          await this.setTransactionDeadline(tx, deadline);
          await setWorkspaceGuc(tx, workspaceId);
          const checkpoint = (await tx<{ bucket_start: Date; bucket_end: Date; exact_totals: unknown }[]>`
            SELECT c.bucket_start, c.bucket_end, c.exact_totals
            FROM storage_rollup_checkpoint c
            JOIN storage_retention_setting s ON s.workspace_id=c.workspace_id
            WHERE c.workspace_id=${workspaceId} AND c.source_grain=${sourceGrain}
              AND c.target_grain=${targetGrain} AND s.enabled_at IS NOT NULL
              AND c.bucket_end < ${now} - (s.${tx.unsafe(cutoffColumn)} * interval '1 day')
              AND EXISTS (
                SELECT 1 FROM usage_aggregate a
                WHERE a.workspace_id=c.workspace_id AND a.grain=${sourceGrain}
                  AND a.bucket_start >= c.bucket_start AND a.bucket_start < c.bucket_end
              )
              AND EXISTS (
                SELECT 1 FROM (
                  SELECT coalesce(sum(p.requests),0)::bigint AS requests,
                    coalesce(sum(p.input_tokens),0)::bigint AS input_tokens,
                    coalesce(sum(p.output_tokens),0)::bigint AS output_tokens,
                    coalesce(sum(p.cache_read_tokens),0)::bigint AS cache_read_tokens,
                    coalesce(sum(p.reasoning_tokens),0)::bigint AS reasoning_tokens,
                    coalesce(sum(p.cache_write_tokens),0)::bigint AS cache_write_tokens,
                    coalesce(sum(p.audio_input_tokens),0)::bigint AS audio_input_tokens,
                    coalesce(sum(p.audio_output_tokens),0)::bigint AS audio_output_tokens,
                    coalesce(sum(p.cost_microusd),0)::bigint AS cost_microusd,
                    coalesce(sum(p.errors),0)::bigint AS errors,
                    coalesce(sum(p.failovers),0)::bigint AS failovers,
                    coalesce(sum(p.latency_ms_sum),0)::bigint AS latency_ms_sum
                  FROM storage_rollup_source_checkpoint p
                  WHERE p.workspace_id=c.workspace_id AND p.source_grain=c.source_grain
                    AND p.target_grain=c.target_grain AND p.bucket_start=c.bucket_start
                ) proof WHERE to_jsonb(proof) = c.exact_totals
              )
            ORDER BY c.bucket_start LIMIT 1
            FOR UPDATE OF c`)[0];
          if (!checkpoint) return [] as { dims_hash: string }[];
          const targetProof = (await tx<{ exact: boolean }[]>`
            SELECT to_jsonb(totals) = c.exact_totals AS exact FROM (
              SELECT coalesce(sum(requests),0)::bigint AS requests,
                coalesce(sum(input_tokens),0)::bigint AS input_tokens,
                coalesce(sum(output_tokens),0)::bigint AS output_tokens,
                coalesce(sum(cache_read_tokens),0)::bigint AS cache_read_tokens,
                coalesce(sum(reasoning_tokens),0)::bigint AS reasoning_tokens,
                coalesce(sum(cache_write_tokens),0)::bigint AS cache_write_tokens,
                coalesce(sum(audio_input_tokens),0)::bigint AS audio_input_tokens,
                coalesce(sum(audio_output_tokens),0)::bigint AS audio_output_tokens,
                coalesce(sum(cost_microusd),0)::bigint AS cost_microusd,
                coalesce(sum(errors),0)::bigint AS errors, coalesce(sum(failovers),0)::bigint AS failovers,
                coalesce(sum(latency_ms_sum),0)::bigint AS latency_ms_sum
              FROM usage_aggregate WHERE workspace_id=${workspaceId} AND grain=${targetGrain}
                AND bucket_start >= ${checkpoint.bucket_start} AND bucket_start < ${checkpoint.bucket_end}
            ) totals
            JOIN storage_rollup_checkpoint c
              ON c.workspace_id=${workspaceId} AND c.target_grain=${targetGrain}
              AND c.bucket_start=${checkpoint.bucket_start}`)[0];
          if (!targetProof?.exact) {
            throw new Error(`aggregate prune proof changed for ${sourceGrain} ${checkpoint.bucket_start.toISOString()}`);
          }
          return tx<{ dims_hash: string }[]>`
            WITH candidates AS (
              SELECT workspace_id, grain, bucket_start, dims_hash FROM usage_aggregate
              WHERE workspace_id=${workspaceId} AND grain=${sourceGrain}
                AND bucket_start >= ${checkpoint.bucket_start} AND bucket_start < ${checkpoint.bucket_end}
              ORDER BY bucket_start, dims_hash LIMIT ${MAX_DELETE_BATCH_ROWS}
            )
            DELETE FROM usage_aggregate a USING candidates c
            WHERE a.workspace_id=c.workspace_id AND a.grain=c.grain
              AND a.bucket_start=c.bucket_start AND a.dims_hash=c.dims_hash
            RETURNING a.dims_hash`;
        }));
        pruned += rows.length;
        if (rows.length === 0) break;
      }
    }
    return pruned;
  }

  async compactEligiblePartitions(workspaceId: string, now = new Date(), limit = Number.MAX_SAFE_INTEGER, deadline?: number) {
    const setting = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      return (await tx<RetentionSettings[]>`SELECT *
        FROM storage_retention_setting WHERE workspace_id = ${workspaceId} LIMIT 1`)[0] ?? null;
    }));
    if (!setting || !setting.export_location) throw new Error("retention deletion requires an export destination");
    if (setting.export_target === "local_filesystem" && process.env.NODE_ENV === "production") throw new Error("retention deletion forbids local filesystem export in production");
    if (setting.export_target !== "local_filesystem" && setting.export_target !== "object_storage") throw new Error("retention deletion requires an export target");
    const targetKind = setting.export_target as "local_filesystem" | "object_storage";
    // Seals are the durable source of truth after DETACH. Always resume them first: detached
    // relations no longer appear in pg_inherits, so catalog-only discovery strands a crash.
    const sealed = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      return tx<SealRow[]>`SELECT s.*, a.exported_at FROM storage_partition_seal s
        JOIN storage_export_attempt a ON a.workspace_id=s.workspace_id AND a.partition_name=s.partition_name
        WHERE s.workspace_id=${workspaceId} AND s.state IN ('sealed', 'export_verified')
        ORDER BY s.created_at, s.partition_name`;
    }));
    const partitions = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      return tx<PartitionRow[]>`
        SELECT parent.relname AS parent_name, child.relname AS partition_name,
          child.oid::text AS partition_oid, pg_get_expr(child.relpartbound, child.oid) AS partition_bound
        FROM pg_inherits i
        JOIN pg_class child ON child.oid = i.inhrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace AND child_ns.nspname = 'public'
        JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname IN ('observation','observation_event','trace_summary','policy_decision','usage_record','cost_ledger')
        ORDER BY parent.relname, child.relname`;
    }));
    const candidates: { partition: PartitionRow; start: Date; end: Date }[] = sealed.map((seal) => ({
      partition: { parent_name: seal.source_relation, partition_name: seal.partition_name, partition_oid: seal.relation_oid, partition_bound: seal.partition_bound },
      start: new Date(seal.range_start), end: new Date(seal.range_end),
    }));
    const sealedNames = new Set(sealed.map((seal) => seal.partition_name));
    for (const partition of partitions) {
      if (!RETENTION_PARENT_ALLOWLIST.has(partition.parent_name) || !IDENTIFIER.test(partition.partition_name)) continue;
      if (sealedNames.has(partition.partition_name)) continue;
      const start = rangeStart(partition.partition_bound);
      const end = rangeEnd(partition.partition_bound);
      if (!start || !end || end > new Date(now.getTime() - retentionDurationMs(setting, partition.parent_name))) continue;
      candidates.push({ partition, start, end });
    }
    const results = [] as { partitionName: string; manifestId: string; rows: number; bytes: number }[];
    for (const { partition, start, end } of candidates.slice(0, Math.max(1, limit))) {
      try {
        results.push(await this.exportCheckpointAndDrop(workspaceId, targetKind, setting.export_location, partition, start, end, deadline));
      } catch (error) {
        if (error instanceof CompactionDeferred) throw error;
        const message = error instanceof Error ? error.message : "unknown export failure";
        throw new PartitionCompactionError(message, results);
      }
    }
    return results;
  }

  /**
   * The retained trace projection is deliberately small, but not permanent.  Keep it for the
   * greater of the configured detail floor and §13.4's 30-day reduced-detail floor, then delete
   * it in <=5,000-row transactions.  A trace past this floor truthfully returns 404 rather than
   * fabricating a per-trace answer from dimension-only usage_aggregate.
   */
  async pruneCompactedTraceProjections(workspaceId: string, maxBatches = Number.MAX_SAFE_INTEGER, deadline?: number): Promise<number> {
    let deleted = 0;
    for (let batches = 0; batches < maxBatches; batches += 1) {
      const rows = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
        await this.setTransactionDeadline(tx, deadline);
        await setWorkspaceGuc(tx, workspaceId);
        return tx<{ trace_id: string }[]>`
          WITH settings AS (
            SELECT greatest(observation_retention_days, ${MIN_COMPACTED_TRACE_RETENTION_DAYS}) AS keep_days
            FROM storage_retention_setting
            WHERE workspace_id = ${workspaceId}
          ), candidates AS (
            SELECT p.ctid
            FROM compacted_trace_projection p
            CROSS JOIN settings s
            WHERE p.workspace_id = ${workspaceId}
              AND p.compacted_at < now() - (s.keep_days * interval '1 day')
            ORDER BY p.compacted_at ASC, p.trace_id ASC
            LIMIT ${MAX_DELETE_BATCH_ROWS}
          )
          DELETE FROM compacted_trace_projection p
          USING candidates c
          WHERE p.ctid = c.ctid
          RETURNING p.trace_id`;
      }));
      deleted += rows.length;
      if (rows.length < MAX_DELETE_BATCH_ROWS) break;
    }
    return deleted;
  }

  private async exportCheckpointAndDrop(workspaceId: string, targetKind: "local_filesystem" | "object_storage", exportLocation: string, partition: PartitionRow, start: Date, end: Date, deadline?: number) {
    const seal = await this.sealPartition(workspaceId, partition, start, end, deadline);
    if (seal.state === "dropped" && seal.export_manifest_id) return { partitionName: seal.partition_name, manifestId: seal.export_manifest_id, rows: 0, bytes: 0 };
    try {
      if (targetKind === "object_storage") {
        const completed = await this.exportOneImmutableChunk(workspaceId, seal, exportLocation, deadline);
        if (!completed) throw new CompactionDeferred("storage chunk persisted; resume on next fire");
        return await this.finalizeChunkManifest(workspaceId, seal, exportLocation, targetKind, deadline);
      }
      const counters = { rows: 0, uncompressedBytes: 0, hash: createHash("sha256") };
      const compressed = Readable.from(this.jsonLines(workspaceId, seal, counters, deadline)).pipe(createGzip());
      const verified = await this.writeLocalStream(exportLocation, seal.object_key, compressed);
      const sha256 = counters.hash.digest("hex");
      const coldManifest = buildColdExportManifest({ sourceRelation: seal.source_relation, start: new Date(seal.range_start), end: new Date(seal.range_end), rowCount: counters.rows, byteCount: verified.byteCount, sha256: verified.sha256, uncompressedSha256: sha256, objectUri: verified.uri, exportedAt: new Date(seal.exported_at).toISOString() });
      const manifestKey = `${seal.object_key}-manifest-${coldManifest.sha256}.json`;
      const verifiedManifest = await this.writeLocalImmutable(exportLocation, manifestKey, coldManifest.bytes, coldManifest.sha256);
      if (verifiedManifest.sha256 !== coldManifest.sha256) throw new Error("export manifest object verification failed");
      return await this.checkpointAndDrop(workspaceId, targetKind, seal, verified, verified.sha256, counters.rows, undefined, deadline);
    } catch (error) {
      if (error instanceof CompactionDeferred) throw error;
      const reason = error instanceof Error ? error.message : "unknown export failure";
      // Object-storage attempts retain independently verified chunks and remain resumable after
      // upload, re-verification, or manifest failures.  finalizeChunkManifest already restores a
      // frozen attempt to `exporting`; do not overwrite that recovery state with terminal failure.
      if (targetKind !== "object_storage") {
        await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
          await this.setTransactionDeadline(tx, deadline);
          await setWorkspaceGuc(tx, workspaceId);
          await tx`UPDATE storage_export_attempt SET state = 'failed', export_manifest_id = NULL,
            last_error = ${reason.slice(0, 2_000)}, updated_at = now()
            WHERE workspace_id = ${workspaceId} AND partition_name = ${partition.partition_name}`;
        }));
      }
      throw error;
    }
  }

  /** Persist exactly one independently compressed keyset chunk; a later fire starts after it. */
  private async exportOneImmutableChunk(workspaceId: string, seal: SealRow, location: string, deadline?: number): Promise<boolean> {
    if (deadline !== undefined && Date.now() >= deadline) throw new CompactionDeferred("storage export deadline reached");
    const prior = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => { await this.setTransactionDeadline(tx, deadline); await setWorkspaceGuc(tx, workspaceId); return tx<{ chunk_number: number; cursor_created_at: string; cursor_row_id: string }[]>`SELECT chunk_number, cursor_created_at::text, cursor_row_id FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} ORDER BY chunk_number DESC LIMIT 1`; }));
    const cursor = prior[0]; const relation = safeIdentifier(seal.sealed_relation); const keyColumn = seal.source_relation === "trace_summary" ? "trace_id" : "id";
    // Keep the cursor comparison entirely in PostgreSQL. Passing a timestamptz through a
    // JavaScript driver may truncate microseconds even if the SELECT projection is text.
    const rows = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => { await this.setTransactionDeadline(tx, deadline); await setWorkspaceGuc(tx, workspaceId); return tx<{ row: unknown | null; cursor_us: string; row_id: string; serialized_bytes: string; oversized: boolean }[]>`WITH prior AS (
      SELECT cursor_created_at, cursor_row_id FROM storage_export_chunk
      WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name}
      ORDER BY chunk_number DESC LIMIT 1
    ), candidates AS (
      SELECT row_to_json(t) AS row,
        (extract(epoch FROM t.created_at) * 1000000)::bigint::text AS cursor_us,
        t.${tx.unsafe(keyColumn)} AS row_id,
        octet_length(row_to_json(t)::text) + 1 AS serialized_bytes
      FROM ${tx.unsafe(relation)} t LEFT JOIN prior p ON true
      WHERE t.workspace_id=${workspaceId} AND (p.cursor_created_at IS NULL
        OR (t.created_at, t.${tx.unsafe(keyColumn)}) > (p.cursor_created_at, p.cursor_row_id))
      ORDER BY t.created_at, t.${tx.unsafe(keyColumn)} LIMIT 500
    ), bounded AS (
      SELECT *, row_number() OVER (ORDER BY cursor_us::bigint, row_id) AS row_number,
        sum(serialized_bytes) OVER (ORDER BY cursor_us::bigint, row_id) AS cumulative_bytes
      FROM candidates
    ), selected AS (
      SELECT row, cursor_us, row_id, serialized_bytes::text, false AS oversized
        FROM bounded WHERE cumulative_bytes <= ${MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES}
      UNION ALL
        SELECT NULL::json AS row, cursor_us, row_id, serialized_bytes::text, true AS oversized
        FROM bounded WHERE row_number = 1 AND serialized_bytes > ${MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES}
    ) SELECT * FROM selected ORDER BY cursor_us::bigint, row_id`; }));
    if (!rows.length) return true;
    const oversized = rows.find((row) => row.oversized);
    if (oversized) throw new Error(`storage export row exceeds ${MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES}-byte chunk limit at cursor ${oversized.cursor_us}/${oversized.row_id}`);
    if (rows.some((row) => row.row === null)) throw new Error("storage export chunk row unexpectedly missing payload");
    const raw = Buffer.from(rows.map((row) => `${JSON.stringify(row.row)}\n`).join(""), "utf8");
    // PostgreSQL selected by its canonical JSON size. Keep a local assertion as a fail-closed
    // guard against any serializer difference between PostgreSQL and Node.
    if (raw.length > MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES) throw new Error(`storage export chunk exceeds ${MAX_EXPORT_CHUNK_UNCOMPRESSED_BYTES}-byte limit`);
    const compressed = gzipSync(raw);
    const sha256 = createHash("sha256").update(compressed).digest("hex"); const rawSha256 = createHash("sha256").update(raw).digest("hex"); const number = (cursor?.chunk_number ?? 0) + 1;
    const controller = this.deadlineController(deadline); let verified;
    try { verified = await this.objectStorage.putImmutable(location, `${seal.object_key}.chunk-${number}-${sha256}.jsonl.gz`, compressed, sha256, "application/gzip", controller.signal); }
    catch (error) { if (controller.signal.aborted) throw new CompactionDeferred("storage export deadline reached"); throw error; }
    const last = rows.at(-1)!;
    await this.withDeadline(deadline, () => this.sql.begin(async (tx) => { await this.setTransactionDeadline(tx, deadline); await setWorkspaceGuc(tx, workspaceId); await tx`SELECT public.append_storage_export_chunk(${seal.partition_name}, ${number}, ${last.cursor_us}::bigint,
      ${last.row_id}, ${rows.length}, ${verified.uri}, ${verified.byteCount}, ${sha256}, ${rawSha256})`;
      const saved = (await tx<{ cursor_created_at: string; cursor_row_id: string; row_count: string; target_uri: string; byte_count: string; sha256: string; uncompressed_sha256: string }[]>`SELECT cursor_created_at::text, cursor_row_id, row_count::text, target_uri, byte_count::text, sha256, uncompressed_sha256 FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND chunk_number=${number}`)[0];
      // Do not round-trip the timestamptz through JavaScript for this check: Date loses the
      // microsecond cursor that the SQL function just accepted.  The SECURITY DEFINER insert
      // itself is the exact database comparison; verify every non-temporal proof field here.
      if (!saved || saved.cursor_row_id !== last.row_id || Number(saved.row_count) !== rows.length || saved.target_uri !== verified.uri || Number(saved.byte_count) !== verified.byteCount || saved.sha256 !== sha256 || saved.uncompressed_sha256 !== rawSha256) throw new Error("durable storage chunk proof conflict"); }));
    return false;
  }

  private async finalizeChunkManifest(workspaceId: string, seal: SealRow, location: string, targetKind: "object_storage", deadline?: number) {
    if (deadline !== undefined && Date.now() >= deadline) throw new CompactionDeferred("storage export deadline reached before manifest");
    let chunks: ChunkProof[];
    try {
      // This transition and snapshot share one row lock with the append SECURITY DEFINER
      // function. Once finalizing is committed, no late proof can change the manifest set.
      chunks = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
        await this.setTransactionDeadline(tx, deadline);
        await setWorkspaceGuc(tx, workspaceId);
        const frozen = await tx`UPDATE storage_export_attempt SET state='finalizing', updated_at=now()
          WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND state='exporting'`;
        if (frozen.count !== 1) {
          const attempt = (await tx<{ state: string }[]>`SELECT state FROM storage_export_attempt WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} FOR UPDATE`)[0];
          if (attempt?.state !== 'finalizing') throw new Error("storage export attempt is not finalizable");
        }
        const proof = await tx<ChunkProof[]>`SELECT chunk_number, cursor_created_at::text, cursor_row_id, row_count::text, target_uri, byte_count::text, sha256, uncompressed_sha256, verified_at::text
          FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} ORDER BY chunk_number FOR UPDATE`;
        await this.assertChunkProofSet(tx, workspaceId, seal);
        return proof;
      }));
      const controller = this.deadlineController(deadline);
      const pending = chunks.filter((chunk) => !chunk.verified_at).slice(0, 8);
      for (const chunk of pending) {
        try { await this.objectStorage.reverifyImmutable(chunk.target_uri, Number(chunk.byte_count), chunk.sha256, controller.signal); }
        catch (error) { if (controller.signal.aborted) throw new CompactionDeferred("storage export deadline reached during chunk verification"); throw error; }
        await this.withDeadline(deadline, () => this.sql.begin(async (tx) => { await this.setTransactionDeadline(tx, deadline); await setWorkspaceGuc(tx, workspaceId); await tx`SELECT public.mark_storage_export_chunk_verified(${seal.partition_name}, ${chunk.chunk_number})`; }));
      }
      if (pending.length > 0 && chunks.some((chunk) => !chunk.verified_at) && pending.length < chunks.filter((chunk) => !chunk.verified_at).length) throw new CompactionDeferred("storage verification page persisted; resume on next fire");
      if (pending.length > 0) {
        const remaining = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => { await this.setTransactionDeadline(tx, deadline); await setWorkspaceGuc(tx, workspaceId); return (await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND verified_at IS NULL`)[0]?.count ?? "0"; }));
        if (Number(remaining) > 0) throw new CompactionDeferred("storage verification page persisted; resume on next fire");
      }
      const totalBytes = chunks.reduce((n, c) => n + Number(c.byte_count), 0); const totalRows = chunks.reduce((n, c) => n + Number(c.row_count), 0);
      const dataRoot = createHash("sha256").update(JSON.stringify(chunks.map(({ chunk_number, sha256, uncompressed_sha256, row_count, byte_count }) => ({ chunk_number, sha256, uncompressed_sha256, row_count, byte_count })))).digest("hex");
      const payload = Buffer.from(`${JSON.stringify({ schema: "manifold.storage-export-chunks.v1", window: { start: new Date(seal.range_start).toISOString(), end: new Date(seal.range_end).toISOString() }, tables: [seal.source_relation], row_counts: { [seal.source_relation]: totalRows }, byte_count: totalBytes, data_root_sha256: dataRoot, exported_at: new Date(seal.exported_at).toISOString(), chunks })}\n`); const root = createHash("sha256").update(payload).digest("hex");
      let manifest;
      try { manifest = await this.objectStorage.putImmutable(location, `${seal.object_key}-manifest-${root}.json`, payload, root, "application/json", controller.signal); }
      catch (error) { if (controller.signal.aborted) throw new CompactionDeferred("storage export deadline reached during manifest"); throw error; }
      try { await this.objectStorage.reverifyImmutable(manifest.uri, payload.length, root, controller.signal); }
      catch (error) { if (controller.signal.aborted) throw new CompactionDeferred("storage export deadline reached during manifest verification"); throw error; }
      return this.checkpointAndDrop(workspaceId, targetKind, seal, { uri: manifest.uri, byteCount: totalBytes, sha256: root }, root, totalRows, chunks, deadline);
    } catch (error) {
      if (!(error instanceof CompactionDeferred)) await this.resetFinalizingAttempt(workspaceId, seal.partition_name, deadline);
      throw error;
    }
  }

  private async resetFinalizingAttempt(workspaceId: string, partitionName: string, deadline?: number): Promise<void> {
    await this.withDeadline(deadline, () => this.sql.begin(async (tx) => { await this.setTransactionDeadline(tx, deadline); await setWorkspaceGuc(tx, workspaceId); await tx`UPDATE storage_export_attempt SET state='exporting', last_error=NULL, updated_at=now()
      WHERE workspace_id=${workspaceId} AND partition_name=${partitionName} AND state='finalizing'`; }));
  }

  private async assertChunkProofSet(tx: TransactionSql, workspaceId: string, seal: SealRow): Promise<void> {
    const relation = safeIdentifier(seal.sealed_relation); const key = seal.source_relation === "trace_summary" ? "trace_id" : "id";
    // All ordering/EOF comparisons deliberately stay in SQL. postgres-js otherwise converts
    // timestamptz values to millisecond Dates before a later bind can use them.
    const proof = (await tx<{ valid: boolean; eof: boolean; counts_exact: boolean }[]>`WITH chunks AS (
      SELECT chunk_number, cursor_created_at, cursor_row_id, row_count,
        lag(chunk_number) OVER (ORDER BY chunk_number) AS prior_number,
        lag(cursor_created_at) OVER (ORDER BY chunk_number) AS prior_created_at,
        lag(cursor_row_id) OVER (ORDER BY chunk_number) AS prior_row_id
      FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name}
    ), last_chunk AS (
      SELECT cursor_created_at, cursor_row_id FROM storage_export_chunk
      WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name}
      ORDER BY chunk_number DESC LIMIT 1
    ), counted AS (
      SELECT c.chunk_number, c.row_count,
        (SELECT count(*)::bigint FROM ${tx.unsafe(relation)} r
          WHERE r.workspace_id=${workspaceId}
            AND (c.prior_created_at IS NULL OR (r.created_at, r.${tx.unsafe(key)}) > (c.prior_created_at, c.prior_row_id))
            AND (r.created_at, r.${tx.unsafe(key)}) <= (c.cursor_created_at, c.cursor_row_id)) AS actual_rows
      FROM chunks c
    ) SELECT
      coalesce(bool_and(chunk_number = coalesce(prior_number, 0) + 1
        AND (prior_created_at IS NULL OR (cursor_created_at, cursor_row_id) > (prior_created_at, prior_row_id))), false) AS valid,
      NOT EXISTS (SELECT 1 FROM ${tx.unsafe(relation)} r CROSS JOIN last_chunk l
        WHERE r.workspace_id=${workspaceId} AND (r.created_at, r.${tx.unsafe(key)}) > (l.cursor_created_at, l.cursor_row_id)) AS eof,
      coalesce((SELECT bool_and(row_count = actual_rows) FROM counted), false)
        AND coalesce((SELECT sum(row_count) FROM counted), 0) = (SELECT count(*) FROM ${tx.unsafe(relation)} WHERE workspace_id=${workspaceId}) AS counts_exact
      FROM chunks`)[0];
    if (!proof?.valid) throw new Error("storage export chunk sequence has a gap or non-monotonic cursor");
    if (!proof.eof) throw new Error("storage export cursor is not at sealed relation EOF");
    if (!proof.counts_exact) throw new Error("storage export chunk row-count proof failed");
  }

  private deadlineController(deadline?: number): AbortController {
    const controller = new AbortController();
    if (deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) controller.abort(); else setTimeout(() => controller.abort(), remaining).unref?.();
    }
    return controller;
  }

  /** Short transaction: validate single-installation cardinality, lock, detach and persist identity. */
  private async sealPartition(workspaceId: string, partition: PartitionRow, start: Date, end: Date, deadline?: number): Promise<SealRow> {
    try { return await this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      const workspaces = await tx<{ id: string }[]>`SELECT id FROM workspace ORDER BY id`;
      if (workspaces.length !== 1 || workspaces[0]?.id !== workspaceId) throw new Error(`database violates ADR-0021 one-workspace invariant; destructive drop of ${partition.partition_name} skipped`);
      await setWorkspaceGuc(tx, workspaceId);
      const existing = (await tx<SealRow[]>`SELECT s.*, a.exported_at FROM storage_partition_seal s
        JOIN storage_export_attempt a ON a.workspace_id=s.workspace_id AND a.partition_name=s.partition_name
        WHERE s.workspace_id=${workspaceId} AND s.partition_name=${partition.partition_name} LIMIT 1`)[0];
      if (existing) {
        // Failure state is diagnostic only; the immutable seal token/object key/exported_at are
        // the retry identity and must never be regenerated.
        if (existing.state === "sealed") await tx`UPDATE storage_export_attempt SET state='exporting', last_error=NULL, updated_at=now()
          WHERE workspace_id=${workspaceId} AND partition_name=${partition.partition_name} AND state='failed'`;
        return (await tx<SealRow[]>`SELECT s.*, a.exported_at FROM storage_partition_seal s
          JOIN storage_export_attempt a ON a.workspace_id=s.workspace_id AND a.partition_name=s.partition_name
          WHERE s.workspace_id=${workspaceId} AND s.partition_name=${partition.partition_name}`)[0]!;
      }
      // The proof is checked in the same short transaction as DETACH. Export proof alone is
      // insufficient: a cold copy of detail does not preserve the aggregate truth required by
      // §13.1/§13.4/§13.6. Re-checking before DROP below also protects resumed old seals.
      await this.assertTruthPreservationProof(tx, workspaceId, partition.parent_name, partition.partition_name, start, end);
      const parent = safeIdentifier(partition.parent_name);
      const child = safeIdentifier(partition.partition_name);
      // This is the only ACCESS EXCLUSIVE section. DETACH makes subsequent parent writes route
      // to default/future partitions before any network request begins.
      await tx.unsafe(`LOCK TABLE public.${parent} IN ACCESS EXCLUSIVE MODE`);
      const attached = (await tx<{ oid: string; bound: string }[]>`SELECT child.oid::text AS oid, pg_get_expr(child.relpartbound, child.oid) AS bound
        FROM pg_inherits i JOIN pg_class child ON child.oid=i.inhrelid JOIN pg_class parent ON parent.oid=i.inhparent
        WHERE parent.relname=${partition.parent_name} AND child.relname=${partition.partition_name} LIMIT 1`)[0];
      if (!attached || attached.oid !== partition.partition_oid || attached.bound !== partition.partition_bound) throw new Error("eligible partition changed before seal");
      await tx.unsafe(`ALTER TABLE public.${parent} DETACH PARTITION public.${child}`);
      const token = randomUUID().replaceAll("-", "");
      const objectKey = `${workspaceId}-${partition.partition_name}-${token}.jsonl.gz`;
      await tx`INSERT INTO storage_export_attempt (workspace_id, partition_name, source_relation, exported_at, state, last_error)
        VALUES (${workspaceId}, ${partition.partition_name}, ${partition.parent_name}, now(), 'exporting', NULL)`;
      await tx`INSERT INTO storage_partition_seal (workspace_id, partition_name, source_relation, sealed_relation, relation_oid,
        partition_bound, range_start, range_end, seal_token, attempt_token, object_key, state)
        VALUES (${workspaceId}, ${partition.partition_name}, ${partition.parent_name}, ${partition.partition_name}, ${partition.partition_oid},
          ${partition.partition_bound}, ${start}, ${end}, ${token}, ${token}, ${objectKey}, 'sealed')`;
      return (await tx<SealRow[]>`SELECT s.*, a.exported_at FROM storage_partition_seal s
        JOIN storage_export_attempt a ON a.workspace_id=s.workspace_id AND a.partition_name=s.partition_name
        WHERE s.workspace_id=${workspaceId} AND s.partition_name=${partition.partition_name}`)[0]!;
    }); } catch (error) { if (this.isDeadlineDatabaseError(error, deadline)) throw new CompactionDeferred("storage seal lock deadline reached"); throw error; }
  }

  /**
   * Fail closed unless the exact detail window has a durable replacement and the projection has
   * checkpointed past that window.  This intentionally rejects proof that is merely plausible:
   * a missing checkpoint, a stale checkpoint, or aggregate totals that do not exactly match the
   * source prevents both DETACH and DROP.
   */
  private async assertTruthPreservationProof(tx: TransactionSql, workspaceId: string, sourceRelation: string, partitionName: string, start: Date, end: Date): Promise<void> {
    const relation = safeIdentifier(partitionName);
    const requireCheckpoints = async (...projections: string[]) => {
      const rows = await tx<{ projection: string }[]>`
        SELECT projection FROM projection_checkpoint
        WHERE workspace_id=${workspaceId} AND projection = ANY(${projections})
          AND last_processed_at IS NOT NULL AND last_processed_at >= ${end}`;
      if (rows.length !== projections.length) {
        throw new Error(`truth preservation checkpoint missing or stale for ${sourceRelation}`);
      }
    };

    if (sourceRelation === "policy_decision") {
      // §13.6 permits shedding this only after an audit-linked summary exists. There is no
      // truthful summary/checkpoint relation in the schema yet, so never infer one from export.
      throw new Error("truth preservation proof unavailable for policy_decision");
    }

    if (sourceRelation === "observation_event") {
      // The reducer checkpoint proves every event in the window reached observation; the
      // aggregate checkpoint proves that resulting durable truth was also materialized.
      await requireCheckpoints(OBSERVATION_REDUCER_PROJECTION, "usage_aggregate");
      return;
    }

    if (sourceRelation === "trace_summary") {
      // Trace summaries are derived detail. Their own projection must be caught up, while the
      // aggregate checkpoint prevents shedding a trace window ahead of usage/cost truth.
      await requireCheckpoints("trace_summary", "usage_aggregate");
      return;
    }

    if (sourceRelation === "observation" || sourceRelation === "usage_record") {
      await requireCheckpoints("usage_aggregate");
      const usageRecord = sourceRelation === "usage_record";
      const rows = await tx<{ source_requests: string; source_input_tokens: string; source_output_tokens: string; source_cache_read_tokens: string; source_reasoning_tokens: string; source_cache_write_tokens: string; source_audio_input_tokens: string; source_audio_output_tokens: string; source_cost_microusd: string; aggregate_requests: string; aggregate_input_tokens: string; aggregate_output_tokens: string; aggregate_cache_read_tokens: string; aggregate_reasoning_tokens: string; aggregate_cache_write_tokens: string; aggregate_audio_input_tokens: string; aggregate_audio_output_tokens: string; aggregate_cost_microusd: string }[]>`
        WITH source AS (
          SELECT count(*)::bigint::text AS source_requests,
            coalesce(sum(input_tokens), 0)::bigint::text AS source_input_tokens,
            coalesce(sum(output_tokens), 0)::bigint::text AS source_output_tokens,
            coalesce(sum(cache_read_tokens), 0)::bigint::text AS source_cache_read_tokens,
            coalesce(sum(reasoning_tokens), 0)::bigint::text AS source_reasoning_tokens,
            coalesce(sum(cache_write_tokens), 0)::bigint::text AS source_cache_write_tokens,
            coalesce(sum(audio_input_tokens), 0)::bigint::text AS source_audio_input_tokens,
            coalesce(sum(audio_output_tokens), 0)::bigint::text AS source_audio_output_tokens,
            ${usageRecord ? tx`0::bigint::text` : tx`coalesce(sum(cost_microusd), 0)::bigint::text`} AS source_cost_microusd
          FROM ${tx.unsafe(relation)} WHERE workspace_id=${workspaceId}
        ), aggregate AS (
          SELECT coalesce(sum(requests), 0)::bigint::text AS aggregate_requests,
            coalesce(sum(input_tokens), 0)::bigint::text AS aggregate_input_tokens,
            coalesce(sum(output_tokens), 0)::bigint::text AS aggregate_output_tokens,
            coalesce(sum(cache_read_tokens), 0)::bigint::text AS aggregate_cache_read_tokens,
            coalesce(sum(reasoning_tokens), 0)::bigint::text AS aggregate_reasoning_tokens,
            coalesce(sum(cache_write_tokens), 0)::bigint::text AS aggregate_cache_write_tokens,
            coalesce(sum(audio_input_tokens), 0)::bigint::text AS aggregate_audio_input_tokens,
            coalesce(sum(audio_output_tokens), 0)::bigint::text AS aggregate_audio_output_tokens,
            coalesce(sum(cost_microusd), 0)::bigint::text AS aggregate_cost_microusd
          FROM usage_aggregate
          WHERE workspace_id=${workspaceId} AND grain='hourly' AND bucket_start >= ${start} AND bucket_start < ${end}
        ) SELECT * FROM source CROSS JOIN aggregate`;
      const proof = rows[0];
      const sameUsage = proof && proof.source_requests === proof.aggregate_requests && proof.source_input_tokens === proof.aggregate_input_tokens && proof.source_output_tokens === proof.aggregate_output_tokens && proof.source_cache_read_tokens === proof.aggregate_cache_read_tokens && proof.source_reasoning_tokens === proof.aggregate_reasoning_tokens && proof.source_cache_write_tokens === proof.aggregate_cache_write_tokens && proof.source_audio_input_tokens === proof.aggregate_audio_input_tokens && proof.source_audio_output_tokens === proof.aggregate_audio_output_tokens;
      if (!sameUsage || (!usageRecord && proof.source_cost_microusd !== proof.aggregate_cost_microusd)) {
        throw new Error(`truth preservation aggregate totals missing or mismatched for ${sourceRelation}`);
      }
      return;
    }

    if (sourceRelation === "cost_ledger") {
      await requireCheckpoints("usage_aggregate", "usage_aggregate_monthly");
      const rows = await tx<{ source_cost_microusd: string; aggregate_cost_microusd: string }[]>`
        WITH source AS (
          SELECT coalesce(sum(amount_microusd), 0)::bigint::text AS source_cost_microusd
          FROM ${tx.unsafe(relation)} WHERE workspace_id=${workspaceId}
        ), aggregate AS (
          SELECT coalesce(sum(cost_microusd), 0)::bigint::text AS aggregate_cost_microusd
          FROM usage_aggregate
          WHERE workspace_id=${workspaceId} AND grain='monthly' AND bucket_start >= ${start} AND bucket_start < ${end}
        ) SELECT * FROM source CROSS JOIN aggregate`;
      const proof = rows[0];
      if (!proof || proof.source_cost_microusd !== proof.aggregate_cost_microusd) {
        throw new Error("monthly cost truth missing or mismatched for cost_ledger");
      }
      return;
    }

    throw new Error(`truth preservation proof unavailable for ${sourceRelation}`);
  }

  /**
   * Materialize the one intentionally retained per-trace read model before a detail partition is
   * dropped.  This is deliberately sourced from `observation` (or the detached observation
   * partition itself), never from `usage_aggregate`: aggregates have dimension buckets, not a
   * trustworthy trace identity.  The subsequent coverage check is an authorization gate, not a
   * metric; no missing trace can be dropped.
   */
  private async checkpointCompactedTraceProjection(
    tx: TransactionSql,
    workspaceId: string,
    sourceRelation: string,
    partitionName: string,
  ): Promise<void> {
    if (!['observation', 'observation_event', 'trace_summary', 'usage_record', 'cost_ledger'].includes(sourceRelation)) return;
    const source = safeIdentifier(partitionName);
    const selectProjection = (from: string) => tx.unsafe(`
      INSERT INTO compacted_trace_projection (
        workspace_id, trace_id, compacted_at,
        input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens,
        audio_input_tokens, audio_output_tokens, usage_fidelity, cost_microusd, cost_fidelity
      )
      SELECT workspace_id, trace_id, now(),
        coalesce(input_tokens, 0), coalesce(output_tokens, 0), coalesce(cache_read_tokens, 0),
        coalesce(reasoning_tokens, 0), coalesce(cache_write_tokens, 0),
        coalesce(audio_input_tokens, 0), coalesce(audio_output_tokens, 0),
        CASE WHEN usage.fidelity IN ('exact', 'estimated', 'unknown') THEN usage.fidelity ELSE 'unknown' END,
        coalesce(cost_microusd, 0),
        CASE WHEN cost_fidelity IN ('exact', 'estimated', 'unknown') THEN cost_fidelity ELSE 'unknown' END
      FROM ${from} source_observation
      LEFT JOIN LATERAL (
        SELECT fidelity FROM usage_record
        WHERE workspace_id = '${workspaceId.replaceAll("'", "''")}' AND trace_id = source_observation.trace_id
        ORDER BY occurred_at DESC, id DESC LIMIT 1
      ) usage ON true
      WHERE workspace_id = '${workspaceId.replaceAll("'", "''")}'
      ON CONFLICT (workspace_id, trace_id) DO NOTHING`);

    if (sourceRelation === 'observation') {
      await selectProjection(`public.${source}`);
    } else {
      await tx.unsafe(`
        INSERT INTO compacted_trace_projection (
          workspace_id, trace_id, compacted_at,
          input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens,
          audio_input_tokens, audio_output_tokens, usage_fidelity, cost_microusd, cost_fidelity
        )
        SELECT o.workspace_id, o.trace_id, now(),
          coalesce(o.input_tokens, 0), coalesce(o.output_tokens, 0), coalesce(o.cache_read_tokens, 0),
          coalesce(o.reasoning_tokens, 0), coalesce(o.cache_write_tokens, 0),
          coalesce(o.audio_input_tokens, 0), coalesce(o.audio_output_tokens, 0),
          CASE WHEN usage.fidelity IN ('exact', 'estimated', 'unknown') THEN usage.fidelity ELSE 'unknown' END,
          coalesce(o.cost_microusd, 0),
          CASE WHEN o.cost_fidelity IN ('exact', 'estimated', 'unknown') THEN o.cost_fidelity ELSE 'unknown' END
        FROM observation o
        JOIN (SELECT DISTINCT trace_id FROM public.${source} WHERE workspace_id = '${workspaceId.replaceAll("'", "''")}') source
          ON source.trace_id = o.trace_id
        LEFT JOIN LATERAL (
          SELECT fidelity FROM usage_record
          WHERE workspace_id = '${workspaceId.replaceAll("'", "''")}' AND trace_id = o.trace_id
          ORDER BY occurred_at DESC, id DESC LIMIT 1
        ) usage ON true
        WHERE o.workspace_id = '${workspaceId.replaceAll("'", "''")}'
        ON CONFLICT (workspace_id, trace_id) DO NOTHING`);
    }

    // The immutable observation row has an explicit whitelisted false->true compaction delta.
    // Flip it while its event partition is shed so a still-retained observation cannot expose a
    // misleading partial waterfall between event and observation retention windows.
    if (sourceRelation === 'observation_event') {
      await tx`
        UPDATE observation SET compacted = true
        WHERE workspace_id = ${workspaceId} AND compacted = false
          AND trace_id IN (SELECT DISTINCT trace_id FROM ${tx.unsafe(source)})`;
    }

    const coverage = await tx<{ source_traces: string; retained_traces: string }[]>`
      WITH source_traces AS (SELECT DISTINCT trace_id FROM ${tx.unsafe(source)} WHERE workspace_id = ${workspaceId})
      SELECT count(*)::bigint::text AS source_traces,
        count(p.trace_id)::bigint::text AS retained_traces
      FROM source_traces s
      LEFT JOIN compacted_trace_projection p
        ON p.workspace_id = ${workspaceId} AND p.trace_id = s.trace_id`;
    const proof = coverage[0];
    if (!proof || proof.source_traces !== proof.retained_traces) {
      throw new Error(`compacted trace projection missing for ${sourceRelation}`);
    }
  }

  /** Bounded keyset stream over a detached relation. No transaction spans this generator. */
  private async *jsonLines(workspaceId: string, seal: SealRow, counters: { rows: number; uncompressedBytes: number; hash: ReturnType<typeof createHash> }, deadline?: number): AsyncGenerator<Buffer> {
    const relation = safeIdentifier(seal.sealed_relation);
    const key = seal.source_relation === "trace_summary" ? "trace_id" : "id";
    let cursorUs: string | null = null;
    let id: string | null = null;
    for (;;) {
      this.throwIfDeadline(deadline);
      const rows = await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
        await this.setTransactionDeadline(tx, deadline);
        await setWorkspaceGuc(tx, workspaceId);
        return tx<{ row: unknown; cursor_us: string; row_id: string }[]>`
          SELECT row_to_json(t) AS row,
            (extract(epoch FROM t.created_at) * 1000000)::bigint::text AS cursor_us,
            t.${tx.unsafe(key)} AS row_id
          FROM ${tx.unsafe(relation)} t
          WHERE t.workspace_id=${workspaceId}
            AND (${cursorUs}::bigint IS NULL OR (t.created_at, t.${tx.unsafe(key)}) >
              (timestamptz 'epoch' + ${cursorUs}::bigint * interval '1 microsecond', ${id}))
          ORDER BY t.created_at, t.${tx.unsafe(key)} LIMIT 500`;
      }));
      if (rows.length === 0) return;
      for (const row of rows) {
        this.throwIfDeadline(deadline);
        const line = Buffer.from(`${JSON.stringify(row.row)}\n`, "utf8");
        counters.rows += 1; counters.uncompressedBytes += line.length; counters.hash.update(line);
        yield line;
      }
      const last = rows[rows.length - 1]!; cursorUs = last.cursor_us; id = last.row_id;
    }
  }

  /** Short final transaction: prove the detached relation is the sealed OID, checkpoint, audit, drop. */
  private async checkpointAndDrop(workspaceId: string, targetKind: "local_filesystem" | "object_storage", seal: SealRow, verified: { uri: string; byteCount: number; sha256: string }, sha256: string, rows: number, expectedChunks?: readonly ChunkProof[], deadline?: number) {
    try { return await this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      const persistedSeal = (await tx<SealRow[]>`SELECT s.*, a.exported_at FROM storage_partition_seal s
        JOIN storage_export_attempt a ON a.workspace_id=s.workspace_id AND a.partition_name=s.partition_name
        WHERE s.workspace_id=${workspaceId} AND s.partition_name=${seal.partition_name} FOR UPDATE OF s, a`)[0];
      if (!persistedSeal || persistedSeal.seal_token !== seal.seal_token || String(persistedSeal.relation_oid) !== String(seal.relation_oid) || persistedSeal.partition_bound !== seal.partition_bound || persistedSeal.state === "dropped") throw new Error("partition seal changed before final drop");
      const attempt = (await tx<{ state: string }[]>`SELECT state FROM storage_export_attempt WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} FOR UPDATE`)[0];
      if (targetKind === "object_storage" && attempt?.state !== "finalizing") throw new Error("storage export attempt is not frozen for final drop");
      const relation = safeIdentifier(seal.sealed_relation);
      const identity = (await tx<{ oid: string }[]>`SELECT c.oid::text AS oid
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${seal.sealed_relation}`)[0];
      // DETACH clears relpartbound, so the original catalog bound is revalidated against the
      // immutable seal record while the OID proves this is still the exact detached relation.
      if (!identity || identity.oid !== String(seal.relation_oid) || persistedSeal.partition_bound !== seal.partition_bound) throw new Error("sealed relation identity changed before final drop");
      // The final drop is authorized only after the durable chunk cursor reaches EOF of the
      // exact sealed relation in this same transaction. A fabricated/gapped early cursor cannot
      // turn a partial export into a destructive drop.
      if (targetKind === "object_storage") {
        const chunks = await tx<ChunkProof[]>`SELECT chunk_number, cursor_created_at::text, cursor_row_id, row_count::text, target_uri, byte_count::text, sha256, uncompressed_sha256
          FROM storage_export_chunk WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} ORDER BY chunk_number FOR UPDATE`;
        await this.assertChunkProofSet(tx, workspaceId, seal);
        if (!expectedChunks || JSON.stringify(chunks.map(({ cursor_created_at: _cursor, verified_at: _verified, ...chunk }) => chunk)) !== JSON.stringify(expectedChunks.map(({ cursor_created_at: _cursor, verified_at: _verified, ...chunk }) => chunk))) throw new Error("storage export chunk proof changed during finalization");
        const exactRows = chunks.reduce((sum, chunk) => sum + Number(chunk.row_count), 0);
        const exactBytes = chunks.reduce((sum, chunk) => sum + Number(chunk.byte_count), 0);
        if (exactRows !== rows || exactBytes !== verified.byteCount) throw new Error("storage export manifest aggregate proof failed");
      }
      await this.checkpointCompactedTraceProjection(tx, workspaceId, seal.source_relation, seal.sealed_relation);
      await this.assertTruthPreservationProof(tx, workspaceId, seal.source_relation, seal.sealed_relation, new Date(seal.range_start), new Date(seal.range_end));
      const manifestId = `sexp_${randomUUID().replaceAll("-", "")}`;
      await tx`INSERT INTO storage_export_manifest (id, workspace_id, source_relation, partition_name, range_start, range_end, target_kind, target_uri, sha256, row_count, byte_count, verified_at)
        VALUES (${manifestId}, ${workspaceId}, ${seal.source_relation}, ${seal.partition_name}, ${seal.range_start}, ${seal.range_end}, ${targetKind}, ${verified.uri}, ${sha256}, ${rows}, ${verified.byteCount}, now())
        ON CONFLICT (workspace_id, partition_name, sha256) DO NOTHING`;
      const manifest = (await tx<ManifestRow[]>`SELECT id, sha256, target_uri, row_count::text, byte_count::text FROM storage_export_manifest
        WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND sha256=${sha256} LIMIT 1`)[0];
      if (!manifest || Number(manifest.row_count) !== rows || Number(manifest.byte_count) !== verified.byteCount || manifest.target_uri !== verified.uri) throw new Error("export manifest proof failed");
      await tx`INSERT INTO storage_compaction_checkpoint (workspace_id, partition_name, export_manifest_id, state, drop_authorized_at)
        VALUES (${workspaceId}, ${seal.partition_name}, ${manifest.id}, 'export_verified', NULL)
        ON CONFLICT (workspace_id, partition_name) DO UPDATE SET export_manifest_id=EXCLUDED.export_manifest_id, state='export_verified', drop_authorized_at=NULL, dropped_at=NULL, updated_at=now()`;
      await tx`UPDATE storage_partition_seal SET state='export_verified', export_manifest_id=${manifest.id}, updated_at=now()
        WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND state='sealed'`;
      await tx`INSERT INTO audit_event (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id, detail, created_at)
        VALUES (${`aud_${randomUUID().replaceAll("-", "")}`}, ${workspaceId}, 'system', 'storage-compactor', 'storage.export.manifest', 'storage_export_manifest', ${manifest.id}, ${tx.json({ partition_name: seal.partition_name, sha256, byte_count: verified.byteCount, target_uri: verified.uri } as never)}, now())`;
      const authorized = await tx`UPDATE storage_compaction_checkpoint SET state='drop_authorized', drop_authorized_at=now(), updated_at=now()
        WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND export_manifest_id=${manifest.id} AND state='export_verified'`;
      if (authorized.count !== 1) throw new Error("retention checkpoint authorization failed");
      await tx.unsafe(`DROP TABLE public.${relation}`);
      await tx`UPDATE storage_compaction_checkpoint SET state='dropped', dropped_at=now(), updated_at=now() WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND export_manifest_id=${manifest.id} AND state='drop_authorized'`;
      await tx`UPDATE storage_partition_seal SET state='dropped', updated_at=now() WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name} AND export_manifest_id=${manifest.id}`;
      await tx`UPDATE storage_export_attempt SET state='verified', export_manifest_id=${manifest.id}, last_error=NULL, updated_at=now() WHERE workspace_id=${workspaceId} AND partition_name=${seal.partition_name}`;
      return { partitionName: seal.partition_name, manifestId: manifest.id, rows, bytes: verified.byteCount };
    }); } catch (error) { if (this.isDeadlineDatabaseError(error, deadline)) throw new CompactionDeferred("storage final drop deadline reached"); throw error; }
  }

  private async setTransactionDeadline(tx: TransactionSql, deadline?: number): Promise<void> {
    if (deadline === undefined) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CompactionDeferred("storage transaction deadline reached");
    const timeout = `${Math.max(1, Math.floor(remaining))}ms`;
    await tx`SELECT set_config('lock_timeout', ${timeout}, true), set_config('statement_timeout', ${timeout}, true)`;
  }

  private throwIfDeadline(deadline?: number): void {
    if (deadline !== undefined && Date.now() >= deadline) throw new CompactionDeferred("storage scheduler deadline reached");
  }

  /** Translate the two PostgreSQL timeout SQLSTATEs into resumable scheduler work. */
  private async withDeadline<T>(deadline: number | undefined, work: () => Promise<T>): Promise<T> {
    this.throwIfDeadline(deadline);
    try {
      return await work();
    } catch (error) {
      if (this.isDeadlineDatabaseError(error, deadline)) {
        throw new CompactionDeferred("storage database deadline reached");
      }
      throw error;
    }
  }

  private isDeadlineDatabaseError(error: unknown, deadline?: number): boolean {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    return deadline !== undefined && (Date.now() >= deadline || code === "55P03" || code === "57014");
  }

  private async writeLocalImmutable(exportRoot: string, filename: string, bytes: Buffer, sha256: string) {
    const root = path.resolve(exportRoot);
    const destination = path.join(root, filename);
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("export path escapes configured root");
    await mkdir(root, { recursive: true });
    try { await stat(destination); } catch {
      const temporary = `${destination}.${randomUUID()}.partial`;
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    }
    return this.verifyLocal(destination, sha256);
  }

  private async writeLocalStream(exportRoot: string, filename: string, chunks: AsyncIterable<Uint8Array>) {
    const root = path.resolve(exportRoot); const destination = path.join(root, filename);
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("export path escapes configured root");
    await mkdir(root, { recursive: true });
    let exists = true;
    try { await stat(destination); } catch { exists = false; }
    if (exists) {
      // Still consume the deterministic source so row counters and the uncompressed hash used by
      // the manifest are reconstructed on retry; no partition-sized buffer is introduced.
      for await (const _ of chunks) { /* source accounting happens in jsonLines */ }
    } else {
      const temporary = `${destination}.${randomUUID()}.partial`;
      await new Promise<void>((resolve, reject) => { const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 }); output.on("error", reject).on("finish", resolve); Readable.from(chunks).pipe(output); });
      await rename(temporary, destination);
    }
    return this.verifyLocal(destination);
  }

  private async verifyLocal(destination: string, expectedSha256?: string) {
    const hash = createHash("sha256"); let byteCount = 0;
    for await (const chunk of createReadStream(destination)) { const bytes = Buffer.from(chunk); byteCount += bytes.length; hash.update(bytes); }
    const sha256 = hash.digest("hex");
    if (expectedSha256 && sha256 !== expectedSha256) throw new Error("export verification failed");
    return { uri: `file://${destination}`, byteCount, sha256 };
  }

  async updateProgress(jobId: string, workspaceId: string, progress: CompactionProgress, deadline?: number): Promise<void> {
    await this.update(jobId, workspaceId, "claimed", progress, undefined, deadline);
  }

  async fail(jobId: string, workspaceId: string, progress: CompactionProgress, blocker: CompactionBlocker, deadline?: number): Promise<void> {
    await this.update(jobId, workspaceId, "failed", progress, blocker, deadline);
  }

  async complete(jobId: string, workspaceId: string, progress: CompactionProgress, deadline?: number): Promise<void> {
    await this.update(jobId, workspaceId, "done", progress, undefined, deadline);
  }

  private async update(jobId: string, workspaceId: string, status: "claimed" | "failed" | "done", progress: CompactionProgress, blocker?: CompactionBlocker, deadline?: number): Promise<void> {
    await this.withDeadline(deadline, () => this.sql.begin(async (tx) => {
      await this.setTransactionDeadline(tx, deadline);
      await setWorkspaceGuc(tx, workspaceId);
      await tx`
        UPDATE job_ledger
        SET status = ${status}, payload = jsonb_set(payload, '{compaction}', ${tx.json(progress as never)}::jsonb, true),
          last_error = ${blocker ? tx.json(blocker as never) : null},
          claimed_at = CASE WHEN ${status} IN ('failed', 'done') THEN NULL ELSE claimed_at END,
          claimed_by = CASE WHEN ${status} IN ('failed', 'done') THEN NULL ELSE claimed_by END,
          updated_at = now()
        WHERE id = ${jobId} AND workspace_id = ${workspaceId} AND kind = ${STORAGE_COMPACT_JOB_KIND}`;
    }));
  }
}

export async function runDirectCompaction(
  jobId: string,
  workspaceId: string,
  workerId: string,
  now?: () => Date,
  options?: import("./compactor.js").CompactionRunOptions,
) {
  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Error("DATABASE_URL_DIRECT is not set");
  const sql = getClient(url, { max: 1 });
  try {
    const { StorageCompactor } = await import("./compactor.js");
    return await new StorageCompactor(new PostgresStorageRepository(sql), now).run(jobId, workspaceId, workerId, options);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Direct-worker entrypoint for the 15-minute storage/measure job. */
export async function runDirectStorageMeasurement(workspaceId: string, measuredAt?: Date): Promise<StoragePressureMeasurement> {
  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Error("DATABASE_URL_DIRECT is not set");
  const sql = getClient(url, { max: 1 });
  try {
    return await new PostgresStorageRepository(sql).measurePressure(workspaceId, measuredAt);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
