import { runDirectStorageMeasurement } from "@manifold/storage";
import { InternalContracts } from "@manifold/contracts";
import { contractOk } from "@/lib/contracts";
import { rawSql } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { requireStorageCronAuthorization, STORAGE_SCHEDULER_WORKSPACE_LIMIT } from "@/lib/storage-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface StorageMeasureFailureOperationalSignal {
  type: "manifold.storage.measure.failed.v1";
  requestId: string;
  stage: "discovery" | "measure";
  workspaceId?: string;
}

export interface StorageMeasurementPassDependencies {
  dueWorkspaces: () => Promise<readonly { workspaceId: string }[]>;
  measure: (workspaceId: string) => Promise<{ compactionJobId?: string | null }>;
  reportDiagnostic: (signal: StorageMeasureFailureOperationalSignal) => void;
}

export interface StorageMeasurementPassResult {
  workspaces: number;
  measured: number;
  compactionsQueued: number;
  failed: number;
}

function reportStorageMeasureDiagnostic(signal: StorageMeasureFailureOperationalSignal): void {
  console.error(JSON.stringify(signal));
}

export async function runStorageMeasurementPass(
  requestId: string,
  dependencies: StorageMeasurementPassDependencies,
): Promise<StorageMeasurementPassResult> {
  let rows: readonly { workspaceId: string }[];
  try {
    rows = await dependencies.dueWorkspaces();
  } catch {
    dependencies.reportDiagnostic({
      type: "manifold.storage.measure.failed.v1",
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
  let measured = 0;
  let compactionsQueued = 0;
  let failed = 0;
  for (const { workspaceId } of rows) {
    try {
      const result = await dependencies.measure(workspaceId);
      measured += 1;
      if (result.compactionJobId) compactionsQueued += 1;
    } catch {
      // The direct worker preserves its own durable state. Never expose database errors in Cron output.
      failed += 1;
      dependencies.reportDiagnostic({
        type: "manifold.storage.measure.failed.v1",
        requestId,
        stage: "measure",
        workspaceId,
      });
    }
  }
  return { workspaces: rows.length, measured, compactionsQueued, failed };
}

/** Vercel Cron must observe a pass where every due workspace failed as a failed invocation. */
export function storageMeasurementPassStatus(result: StorageMeasurementPassResult): 200 | 503 {
  return result.workspaces > 0 && result.failed === result.workspaces ? 503 : 200;
}

/** Bounded 15-minute measurement pass; failures remain count-only so no DB topology leaks. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    requireStorageCronAuthorization(req);
    const result = await runStorageMeasurementPass(requestId, {
      dueWorkspaces: async () => {
        const rows = await rawSql()<{ workspace_id: string }[]>`
          SELECT workspace_id FROM storage_scheduler_due_workspaces(${STORAGE_SCHEDULER_WORKSPACE_LIMIT})`;
        return rows.map(({ workspace_id: workspaceId }) => ({ workspaceId }));
      },
      measure: runDirectStorageMeasurement,
      reportDiagnostic: reportStorageMeasureDiagnostic,
    });
    return contractOk(
      InternalContracts.storageMeasureCronResponse,
      result,
      requestId,
      storageMeasurementPassStatus(result),
    );
  });
}
