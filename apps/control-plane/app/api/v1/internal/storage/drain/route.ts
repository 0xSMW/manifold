import { runDirectCompaction, type CompactionResult } from "@manifold/storage";
import { InternalContracts } from "@manifold/contracts";
import { contractOk } from "@/lib/contracts";
import { rawSql } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import {
  requireStorageCronAuthorization,
  storageSchedulerDeadline,
  storageSchedulerHasTime,
  STORAGE_SCHEDULER_DRAIN_LIMIT,
} from "@/lib/storage-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface StorageDrainFailureOperationalSignal {
  type: "manifold.storage.drain.failed.v1";
  requestId: string;
  stage: "discovery" | "drain";
  workspaceId?: string;
  jobId?: string;
}

export interface StorageDrainBlockedOperationalSignal {
  type: "manifold.storage.drain.blocked.v1";
  requestId: string;
  workspaceId: string;
  jobId: string;
  blockerCode: "RETENTION_PREREQUISITES_MISSING" | "EXPORT_VERIFICATION_FAILED";
}

export interface StorageDrainPassDependencies {
  dueJobs: () => Promise<readonly { jobId: string; workspaceId: string }[]>;
  hasTime: () => boolean;
  compact: (jobId: string, workspaceId: string) => Promise<CompactionResult>;
  reportDiagnostic: (signal: StorageDrainFailureOperationalSignal | StorageDrainBlockedOperationalSignal) => void;
}

export interface StorageDrainPassResult {
  discovered: number;
  done: number;
  blocked: number;
  contention: number;
  incomplete: number;
  notFound: number;
  failed: number;
}

function reportStorageDrainDiagnostic(
  signal: StorageDrainFailureOperationalSignal | StorageDrainBlockedOperationalSignal,
): void {
  console.error(JSON.stringify(signal));
}

export async function runStorageDrainPass(
  requestId: string,
  dependencies: StorageDrainPassDependencies,
): Promise<StorageDrainPassResult> {
  let rows: readonly { jobId: string; workspaceId: string }[];
  try {
    rows = await dependencies.dueJobs();
  } catch {
    dependencies.reportDiagnostic({
      type: "manifold.storage.drain.failed.v1",
      requestId,
      stage: "discovery",
    });
    throw new ManifoldError({
      status: 500,
      code: "INTERNAL",
      message: "internal error",
      reasonCodes: [],
      retryable: true,
    });
  }
  const counts = { done: 0, blocked: 0, contention: 0, incomplete: 0, notFound: 0, failed: 0 };
  for (const { jobId, workspaceId } of rows) {
    // A job is never marked complete here. StorageCompactor persists its seal/export progress
    // and only marks done after all remaining units finish; an unclaimed backlog resumes next fire.
    if (!dependencies.hasTime()) break;
    try {
      const result = await dependencies.compact(jobId, workspaceId);
      if (result.status === "done") counts.done += 1;
      else if (result.status === "blocked") {
        counts.blocked += 1;
        dependencies.reportDiagnostic({
          type: "manifold.storage.drain.blocked.v1",
          requestId,
          workspaceId,
          jobId,
          blockerCode: result.blocker.code,
        });
      }
      else if (result.status === "contention") counts.contention += 1;
      else if (result.status === "incomplete") counts.incomplete += 1;
      else counts.notFound += 1;
    } catch {
      // The job remains in the durable ledger and becomes eligible after its claim lease expires.
      counts.failed += 1;
      dependencies.reportDiagnostic({
        type: "manifold.storage.drain.failed.v1",
        requestId,
        stage: "drain",
        workspaceId,
        jobId,
      });
    }
  }
  return { discovered: rows.length, ...counts };
}

/** A terminal blocker has its own durable ledger state and operational signal; only worker failures fail Cron. */
export function storageDrainPassStatus(result: StorageDrainPassResult): 200 | 503 {
  return result.discovered > 0 && result.failed === result.discovered ? 503 : 200;
}

/** A direct compactor receives both discovered identities and re-checks them in its RLS transaction. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    requireStorageCronAuthorization(req);
    const deadline = storageSchedulerDeadline();
    const result = await runStorageDrainPass(requestId, {
      dueJobs: async () => {
        const rows = await rawSql()<{ job_id: string; workspace_id: string }[]>`
          SELECT job_id, workspace_id FROM storage_compaction_due_jobs(${STORAGE_SCHEDULER_DRAIN_LIMIT})`;
        return rows.map(({ job_id: jobId, workspace_id: workspaceId }) => ({ jobId, workspaceId }));
      },
      hasTime: () => storageSchedulerHasTime(deadline),
      compact: (jobId, workspaceId) => runDirectCompaction(jobId, workspaceId, `storage-cron:${requestId}`, undefined, {
          deadline,
          maxClosedHours: 1,
          maxPartitions: 1,
          maxMaintenanceBatches: 1,
      }),
      reportDiagnostic: reportStorageDrainDiagnostic,
    });
    return contractOk(
      InternalContracts.storageCompactionDrainResponse,
      result,
      requestId,
      storageDrainPassStatus(result),
    );
  });
}
