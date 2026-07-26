// GET /api/v1/storage — current footprint and storage-bounded-mode state (SPEC §13).
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { StorageContracts } from "@manifold/contracts";
import { isValidObjectStorageLocation, objectStorageConfigurationError } from "@manifold/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WorkspaceRow {
  storage_ceiling_bytes: string;
  storage_warn_pct: number;
  storage_high_pct: number;
  storage_crit_pct: number;
}

interface StorageStatRow {
  measured_at: string;
  total_bytes: string;
  table_bytes: unknown;
  index_bytes: string;
  toast_bytes: string;
  ceiling_bytes: string;
  used_pct: string;
  growth_bytes_per_day: string | null;
  forecast_exhaustion_at: string | null;
}
interface PressureRow { tier: "normal" | "warning" | "high" | "critical" | "emergency"; capture_mode: "none" | "metadata" | "redacted" | "full"; payload_sample_rate: string; journal_mode: "full" | "aggregate_only"; }

interface JobRow {
  id: string;
  status: string;
  created_at: string;
  claimed_at: string | null;
  updated_at: string;
  last_error: unknown;
  payload: unknown;
}
interface RetentionRow { observation_retention_days: number; export_target: string; export_location: string | null; enabled_at: string | null; updated_at: string; }
interface CheckpointRow { state: string; count: string; }

function numberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tierFor(usedPct: number, warn: number, high: number, crit: number): string {
  if (usedPct >= 100) return "emergency";
  if (usedPct >= crit) return "critical";
  if (usedPct >= high) return "high";
  if (usedPct >= warn) return "warning";
  return "normal";
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "storage:read");
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const workspace = (await sql<WorkspaceRow[]>`
        SELECT storage_ceiling_bytes::text, storage_warn_pct, storage_high_pct, storage_crit_pct
        FROM workspace WHERE id = ${principal.workspaceId} LIMIT 1`)[0] ?? null;
      const stat = (await sql<StorageStatRow[]>`
        SELECT measured_at, total_bytes::text, table_bytes, index_bytes::text, toast_bytes::text,
               ceiling_bytes::text, used_pct::text, growth_bytes_per_day::text,
               forecast_exhaustion_at
        FROM storage_stat WHERE workspace_id = ${principal.workspaceId}
        ORDER BY measured_at DESC LIMIT 1`)[0] ?? null;
      const pressure = (await sql<PressureRow[]>`
        SELECT tier, capture_mode, payload_sample_rate::text, journal_mode
        FROM storage_pressure_state WHERE workspace_id = ${principal.workspaceId} LIMIT 1`)[0] ?? null;
      const compaction = (await sql<JobRow[]>`
        SELECT id, status, created_at, claimed_at, updated_at, last_error, payload
        FROM job_ledger
        WHERE workspace_id = ${principal.workspaceId} AND kind = 'storage.compact'
        ORDER BY created_at DESC LIMIT 1`)[0] ?? null;
      const retention = (await sql<RetentionRow[]>`SELECT observation_retention_days, export_target, export_location, enabled_at, updated_at
        FROM storage_retention_setting WHERE workspace_id = ${principal.workspaceId} LIMIT 1`)[0] ?? null;
      const checkpoints = (await sql<CheckpointRow[]>`SELECT state, count(*)::text FROM storage_compaction_checkpoint
        WHERE workspace_id = ${principal.workspaceId} GROUP BY state`);
      return { workspace, stat, pressure, compaction, retention, checkpoints };
    });

    const thresholds = result.workspace ? {
      warnPct: result.workspace.storage_warn_pct,
      highPct: result.workspace.storage_high_pct,
      critPct: result.workspace.storage_crit_pct,
    } : null;
    const usedPct = numberOrNull(result.stat?.used_pct);
    const fallbackTier = thresholds && usedPct !== null
      ? tierFor(usedPct, thresholds.warnPct, thresholds.highPct, thresholds.critPct) : null;
    const tier = result.pressure?.tier ?? fallbackTier;
    const pressure = result.pressure
      ? { captureMode: result.pressure.capture_mode, payloadSampleRate: numberOrNull(result.pressure.payload_sample_rate) ?? 0, journalMode: result.pressure.journal_mode, source: "persisted" as const }
      : fallbackTier
        ? { captureMode: "full" as const, payloadSampleRate: 1, journalMode: "full" as const, source: "fallback" as const }
        : null;
    const tableBytes = result.stat?.table_bytes && typeof result.stat.table_bytes === "object"
      ? result.stat.table_bytes
      : null;

    return contractOk(StorageContracts.overviewResponse, {
      measuredAt: result.stat?.measured_at ?? null,
      usedBytes: result.stat?.total_bytes ?? null,
      ceilingBytes: result.stat?.ceiling_bytes ?? result.workspace?.storage_ceiling_bytes ?? null,
      usedPct,
      tier,
      pressure,
      thresholds,
      tables: tableBytes,
      indexesBytes: result.stat?.index_bytes ?? null,
      toastBytes: result.stat?.toast_bytes ?? null,
      growthBytesPerDay: result.stat?.growth_bytes_per_day ?? null,
      forecastExhaustionAt: result.stat?.forecast_exhaustion_at ?? null,
      retention: result.retention ? {
        available: true, observationRetentionDays: result.retention.observation_retention_days,
        exportTarget: result.retention.export_target, exportConfigured: Boolean(result.retention.export_location), enabled: Boolean(result.retention.enabled_at),
        destructiveDeletion: result.retention.enabled_at && result.retention.export_location && (
          (result.retention.export_target === "local_filesystem" && process.env.NODE_ENV !== "production") ||
          (result.retention.export_target === "object_storage" && isValidObjectStorageLocation(result.retention.export_location) && !objectStorageConfigurationError())
        ) ? "eligible_after_verified_export" : "blocked",
        checkpoints: Object.fromEntries(result.checkpoints.map((row) => [row.state, Number(row.count)])),
      } : { available: true, observationRetentionDays: null, exportTarget: "disabled", exportConfigured: false, enabled: false, destructiveDeletion: "blocked", checkpoints: {} },
      lastCompaction: result.compaction ? {
        id: result.compaction.id,
        status: result.compaction.status,
        queuedAt: result.compaction.created_at,
        claimedAt: result.compaction.claimed_at,
        updatedAt: result.compaction.updated_at,
        error: result.compaction.last_error,
        freedBytes: typeof result.compaction.payload === "object" && result.compaction.payload !== null
          ? Number(((result.compaction.payload as { compaction?: { freedBytes?: unknown } }).compaction?.freedBytes ?? NaN)) || null : null,
        progress: typeof result.compaction.payload === "object" && result.compaction.payload !== null
          ? (result.compaction.payload as { compaction?: unknown }).compaction ?? null : null,
      } : null,
    }, requestId);
  });
}
