import { InternalContracts } from "@manifold/contracts";
import { contractOk, contractQuery } from "@/lib/contracts";
import { rawSql } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import { requireStorageCronAuthorization, STORAGE_SCHEDULER_WORKSPACE_LIMIT } from "@/lib/storage-scheduler";

export type StorageCompactionCadence = "hourly" | "daily" | "monthly";

/** One durable trigger per cadence window; StorageCompactor supplies idempotent missed-window catch-up. */
export async function scheduleStorageCompaction(req: Request, cadence: StorageCompactionCadence): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    requireStorageCronAuthorization(req);
    contractQuery(new URL(req.url).searchParams, InternalContracts.emptyQuery);
    const rows = await rawSql()<{ workspace_id: string; job_id: string | null; enqueued: boolean }[]>`
      SELECT workspace_id, job_id, enqueued
      FROM enqueue_storage_compaction_schedule(${cadence}, ${STORAGE_SCHEDULER_WORKSPACE_LIMIT})`;
    return contractOk(InternalContracts.storageCompactionScheduleResponse, {
      cadence, workspaces: rows.length, queued: rows.filter((row) => row.enqueued).length,
    }, requestId);
  });
}
