// Internal direct-DB compaction worker. It is deliberately separate from the browser queue API.
import { timingSafeEqual } from "node:crypto";
import { runDirectCompaction } from "@manifold/storage";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { InternalContracts } from "@manifold/contracts";
import { contractOk, contractQuery } from "@/lib/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Leave response headroom inside this route's explicit 30-second function limit. */
const DIRECT_COMPACTION_BUDGET_MS = 25_000;

function sameSecret(presented: string | null, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if (!sameSecret(req.headers.get("x-manifold-storage-secret"), process.env.MANIFOLD_STORAGE_COMPACTION_SECRET)) {
      throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing internal compaction secret", reasonCodes: [] });
    }
    const { jobId, workspaceId } = contractQuery(new URL(req.url).searchParams, InternalContracts.storageCompactionQuery);
    const result = await runDirectCompaction(jobId, workspaceId, `cron:${requestId}`, undefined, {
      deadline: Date.now() + DIRECT_COMPACTION_BUDGET_MS,
      maxClosedHours: 1,
      maxPartitions: 1,
      maxMaintenanceBatches: 1,
    });
    const status = result.status === "contention" ? 409 : result.status === "not_found" ? 404 : 200;
    return contractOk(InternalContracts.storageCompactionResponse, result, requestId, status);
  });
}
