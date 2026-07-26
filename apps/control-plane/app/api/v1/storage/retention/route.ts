// GET/POST /api/v1/storage/retention — explicit opt-in retention configuration.
import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { withWorkspace, type Sql } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { StorageContracts } from "@manifold/contracts";
import { isValidObjectStorageLocation, objectStorageConfigurationError } from "@manifold/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Setting = { observation_retention_days: number; export_target: string; export_location: string | null; enabled_at: string | null; updated_at: string };

function view(setting: Setting | null) {
  if (!setting) return { configured: false, observationRetentionDays: null, exportTarget: "disabled", exportConfigured: false, destructiveDeletion: "blocked", remediation: "configure a verified export destination before enabling retention" };
  const localForbidden = setting.export_target === "local_filesystem" && process.env.NODE_ENV === "production";
  const objectStorageError = setting.export_target === "object_storage"
    ? (!isValidObjectStorageLocation(setting.export_location) ? "exportLocation must be an s3://bucket/optional-prefix URI" : objectStorageConfigurationError())
    : null;
  const ready = Boolean(setting.enabled_at && setting.export_location && !localForbidden && !objectStorageError);
  return {
    configured: Boolean(setting.enabled_at), observationRetentionDays: setting.observation_retention_days,
    exportTarget: setting.export_target, exportConfigured: Boolean(setting.export_location),
    destructiveDeletion: ready ? "eligible_after_verified_export" : "blocked",
    remediation: ready ? null : localForbidden ? "local filesystem export is forbidden in production; configure object storage" : objectStorageError ? `object storage export is blocked: ${objectStorageError}` : "configure and enable an explicit export destination",
    updatedAt: setting.updated_at,
  };
}

async function current(sql: Sql, workspaceId: string): Promise<Setting | null> {
  return (await sql<Setting[]>`SELECT observation_retention_days, export_target, export_location, enabled_at, updated_at
    FROM storage_retention_setting WHERE workspace_id = ${workspaceId} LIMIT 1`)[0] ?? null;
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    contractQuery(new URL(req.url).searchParams, StorageContracts.retentionQuery);
    const principal = await authorize(req, "storage:read");
    const setting = await withWorkspace(principal.workspaceId, (sql) => current(sql, principal.workspaceId));
    return contractOk(StorageContracts.retentionResponse, view(setting), requestId);
  });
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    contractQuery(new URL(req.url).searchParams, StorageContracts.retentionQuery);
    const principal = await authorize(req, "storage:write");
    requireMutationIdempotencyKey(req);
    return runMutationGuard({ request: req, principal, requestId, handler: async (sql) => {
      const body = await contractBody(req, StorageContracts.retentionRequest);
      const observationRetentionDays = body.observationRetentionDays;
      const exportTarget = body.exportTarget;
      const exportLocation = body.exportLocation;
      const enabled = body.enabled;
      if (!Number.isInteger(observationRetentionDays) || (observationRetentionDays as number) < 1 || (observationRetentionDays as number) > 3650) {
        throw new ManifoldError({ status: 422, code: "VALIDATION", message: "observationRetentionDays must be an integer from 1 to 3650", reasonCodes: [] });
      }
      if (exportTarget !== "disabled" && exportTarget !== "local_filesystem" && exportTarget !== "object_storage") {
        throw new ManifoldError({ status: 422, code: "VALIDATION", message: "exportTarget must be disabled, local_filesystem, or object_storage", reasonCodes: [] });
      }
      if (typeof enabled !== "boolean") throw new ManifoldError({ status: 422, code: "VALIDATION", message: "enabled must be boolean", reasonCodes: [] });
      if (exportTarget === "disabled" && enabled) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "retention cannot be enabled without an export target", reasonCodes: ["EXPORT_REQUIRED"] });
      if (exportTarget !== "disabled" && (typeof exportLocation !== "string" || !exportLocation.trim())) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "exportLocation is required for an export target", reasonCodes: ["EXPORT_LOCATION_REQUIRED"] });
      if (exportTarget === "local_filesystem" && !String(exportLocation).startsWith("/")) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "local filesystem exportLocation must be an absolute operator-managed path", reasonCodes: [] });
      if (exportTarget === "object_storage" && !isValidObjectStorageLocation(String(exportLocation))) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "object storage exportLocation must be an s3://bucket/optional-prefix URI", reasonCodes: ["OBJECT_STORAGE_LOCATION_INVALID"] });
      if (enabled && exportTarget === "object_storage" && objectStorageConfigurationError()) throw new ManifoldError({ status: 422, code: "VALIDATION", message: `object storage export is not ready: ${objectStorageConfigurationError()}`, reasonCodes: ["OBJECT_STORAGE_NOT_CONFIGURED"] });
      const days = observationRetentionDays as number;
      const target = exportTarget as "disabled" | "local_filesystem" | "object_storage";
      const location = target === "disabled" ? null : String(exportLocation);
      const before = await current(sql, principal.workspaceId);
      const rows = await sql<Setting[]>`INSERT INTO storage_retention_setting (workspace_id, observation_retention_days, export_target, export_location, enabled_at, updated_by_kind, updated_by_id)
        VALUES (${principal.workspaceId}, ${days}, ${target}, ${location}, ${enabled ? new Date() : null}, ${principal.actorKind}, ${principal.actorId})
        ON CONFLICT (workspace_id) DO UPDATE SET observation_retention_days = EXCLUDED.observation_retention_days,
          export_target = EXCLUDED.export_target, export_location = EXCLUDED.export_location, enabled_at = EXCLUDED.enabled_at,
          updated_by_kind = EXCLUDED.updated_by_kind, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()
        RETURNING observation_retention_days, export_target, export_location, enabled_at, updated_at`;
      await audit(sql, principal, { action: "storage.retention.update", targetKind: "storage_retention_setting", targetId: principal.workspaceId, requestId,
        detail: { before: before ? view(before) : null, after: view(rows[0] ?? null) } });
      return contractOk(StorageContracts.retentionResponse, view(rows[0] ?? null), requestId);
    }});
  });
}
