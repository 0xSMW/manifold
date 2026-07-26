// POST /api/v1/storage/thresholds — update and immediately re-tier the latest measurement.
import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { StorageContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function percent(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new ManifoldError({ status: 422, code: "VALIDATION", message: `field '${field}' must be an integer between 1 and 100`, reasonCodes: [] });
  }
  return value;
}

function tierFor(usedPct: number, warn: number, high: number, crit: number): string {
  if (usedPct >= 100) return "emergency";
  if (usedPct >= crit) return "critical";
  if (usedPct >= high) return "high";
  if (usedPct >= warn) return "warning";
  return "normal";
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "storage:write");
    requireMutationIdempotencyKey(req);
    const body = await contractBody(req.clone(), StorageContracts.thresholds);
    const warnPct = percent(body, "warnPct");
    const highPct = percent(body, "highPct");
    const critPct = percent(body, "critPct");
    if (!(warnPct < highPct && highPct < critPct)) {
      throw new ManifoldError({ status: 422, code: "VALIDATION", message: "storage thresholds must satisfy warnPct < highPct < critPct", reasonCodes: ["THRESHOLDS_UNORDERED"] });
    }

    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 10, windowMs: 60_000 }, handler: async (sql) => {
    const result = await (async () => {
      const previous = (await sql<{ storage_warn_pct: number; storage_high_pct: number; storage_crit_pct: number }[]>`
        SELECT storage_warn_pct, storage_high_pct, storage_crit_pct FROM workspace
        WHERE id = ${principal.workspaceId} LIMIT 1`)[0];
      const updated = (await sql<{ storage_ceiling_bytes: string }[]>`
        UPDATE workspace SET storage_warn_pct = ${warnPct}, storage_high_pct = ${highPct},
          storage_crit_pct = ${critPct}, updated_at = now()
        WHERE id = ${principal.workspaceId}
        RETURNING storage_ceiling_bytes::text`)[0];
      const latest = (await sql<{ used_pct: string; measured_at: string }[]>`
        SELECT used_pct::text, measured_at FROM storage_stat
        WHERE workspace_id = ${principal.workspaceId} ORDER BY measured_at DESC LIMIT 1`)[0] ?? null;
      await audit(sql, principal, {
        action: "storage.thresholds.update", targetKind: "workspace", targetId: principal.workspaceId,
        requestId, detail: { before: previous ?? null, after: { warnPct, highPct, critPct } },
      });
      return { updated, latest };
    })();
    const usedPct = result.latest ? Number(result.latest.used_pct) : null;
    return contractOk(StorageContracts.thresholdsResponse, {
      thresholds: { warnPct, highPct, critPct },
      ceilingBytes: result.updated?.storage_ceiling_bytes ?? null,
      measuredAt: result.latest?.measured_at ?? null,
      usedPct: usedPct !== null && Number.isFinite(usedPct) ? usedPct : null,
      tier: usedPct !== null && Number.isFinite(usedPct) ? tierFor(usedPct, warnPct, highPct, critPct) : null,
    }, requestId);
    }});
  });
}
