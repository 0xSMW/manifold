import { runDirectCompaction } from "@manifold/storage";
import { InternalContracts } from "@manifold/contracts";
import { contractOk } from "@/lib/contracts";
import { rawSql } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import {
  requireStorageCronAuthorization,
  storageSchedulerDeadline,
  storageSchedulerHasTime,
  STORAGE_SCHEDULER_DRAIN_LIMIT,
} from "@/lib/storage-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A direct compactor receives both discovered identities and re-checks them in its RLS transaction. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    requireStorageCronAuthorization(req);
    const deadline = storageSchedulerDeadline();
    const rows = await rawSql()<{ job_id: string; workspace_id: string }[]>`
      SELECT job_id, workspace_id FROM storage_compaction_due_jobs(${STORAGE_SCHEDULER_DRAIN_LIMIT})`;
    const counts = { done: 0, blocked: 0, contention: 0, incomplete: 0, notFound: 0, failed: 0 };
    for (const { job_id: jobId, workspace_id: workspaceId } of rows) {
      // A job is never marked complete here. StorageCompactor persists its seal/export progress
      // and only marks done after all remaining units finish; an unclaimed backlog resumes next fire.
      if (!storageSchedulerHasTime(deadline)) break;
      try {
        const result = await runDirectCompaction(jobId, workspaceId, `storage-cron:${requestId}`, undefined, {
          deadline,
          maxClosedHours: 1,
          maxPartitions: 1,
          maxMaintenanceBatches: 1,
        });
        if (result.status === "done") counts.done += 1;
        else if (result.status === "blocked") counts.blocked += 1;
        else if (result.status === "contention") counts.contention += 1;
        else if (result.status === "incomplete") counts.incomplete += 1;
        else counts.notFound += 1;
      } catch {
        // The job remains in the durable ledger and becomes eligible after its claim lease expires.
        counts.failed += 1;
      }
    }
    return contractOk(InternalContracts.storageCompactionDrainResponse, { discovered: rows.length, ...counts }, requestId);
  });
}
