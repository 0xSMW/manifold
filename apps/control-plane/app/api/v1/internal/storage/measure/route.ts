import { runDirectStorageMeasurement } from "@manifold/storage";
import { InternalContracts } from "@manifold/contracts";
import { contractOk } from "@/lib/contracts";
import { rawSql } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import { requireStorageCronAuthorization, STORAGE_SCHEDULER_WORKSPACE_LIMIT } from "@/lib/storage-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounded 15-minute measurement pass; failures remain count-only so no DB topology leaks. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    requireStorageCronAuthorization(req);
    const rows = await rawSql()<{ workspace_id: string }[]>`
      SELECT workspace_id FROM storage_scheduler_due_workspaces(${STORAGE_SCHEDULER_WORKSPACE_LIMIT})`;
    let measured = 0;
    let compactionsQueued = 0;
    let failed = 0;
    for (const { workspace_id: workspaceId } of rows) {
      try {
        const result = await runDirectStorageMeasurement(workspaceId);
        measured += 1;
        if (result.compactionJobId) compactionsQueued += 1;
      } catch {
        // The direct worker preserves its own durable state. Never expose database errors in Cron output.
        failed += 1;
      }
    }
    return contractOk(InternalContracts.storageMeasureCronResponse, { workspaces: rows.length, measured, compactionsQueued, failed }, requestId);
  });
}
