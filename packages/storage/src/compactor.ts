export const STORAGE_COMPACT_JOB_KIND = "storage.compact";
/** Durable reducer coverage used to authorize observation-event retention. */
export const OBSERVATION_REDUCER_PROJECTION = "observation_reducer";
export const MAX_DELETE_BATCH_ROWS = 5_000;
/** §13.4 keeps reduced trace legibility for at least this long, independent of a shorter detail setting. */
export const MIN_COMPACTED_TRACE_RETENTION_DAYS = 30;
/** These relations are outside the compactor's authority under every retention tier. */
export const COMPACTION_TRUTH_TABLE_EXCLUSIONS = Object.freeze([
  "audit_event", "budget_account", "budget_allocation", "budget_reservation", "budget_window_state",
  "gateway_config_revision", "config_operation", "usage_aggregate",
] as const);

export type CompactionStep = "measured_before" | "hourly_aggregated" | "aggregate_rollups" | "blocked" | "measured_after";

export interface CompactionProgress {
  version: 1;
  steps: CompactionStep[];
  closedHour?: string;
  closedHours?: string[];
  beforeBytes?: number;
  afterBytes?: number;
  freedBytes?: number;
  blocker?: CompactionBlocker;
  partitionOutcomes?: readonly RetentionDeleteResult[];
}

export interface CompactionBlocker {
  code: "RETENTION_PREREQUISITES_MISSING" | "EXPORT_VERIFICATION_FAILED";
  missing: readonly string[];
  /** Present only when this run did not complete any destructive partition work. */
  destructiveWorkSkipped?: true;
}

export interface RetentionDeleteResult {
  partitionName: string;
  manifestId: string;
  rows: number;
  bytes: number;
}

/** Carries already-committed partition results when a later bounded transaction fails. */
export class PartitionCompactionError extends Error {
  constructor(message: string, readonly outcomes: readonly RetentionDeleteResult[]) { super(message); }
}
/** A durable export reached its invocation budget; its seal and multipart proofs remain resumable. */
export class CompactionDeferred extends Error {}

export interface CompactionJob {
  id: string;
  workspaceId: string;
  payload: unknown;
  status: "pending" | "claimed" | "done" | "failed" | "dead";
}

export interface StorageRepository {
  tryLock(workspaceId: string, deadline?: number): Promise<boolean>;
  claim(jobId: string, workspaceId: string, workerId: string, deadline?: number): Promise<CompactionJob | null>;
  measure(deadline?: number): Promise<number>;
  /** Every source hour that is fully closed and lacks its own durable rollup checkpoint. */
  listUncheckpointedClosedHours(workspaceId: string, now: Date, limit?: number, deadline?: number): Promise<readonly Date[]>;
  aggregateClosedHour(workspaceId: string, closedHour: Date, deadline?: number): Promise<void>;
  /** Idempotently fold every fully closed hourly/day window into durable coarser grains. */
  rollupClosedWindows(workspaceId: string, now: Date, deadline?: number): Promise<void>;
  retentionPrerequisites(workspaceId: string, deadline?: number): Promise<readonly string[]>;
  /** Export, hash, checkpoint and drop only an explicit safe partition allowlist. */
  compactEligiblePartitions(workspaceId: string, now: Date, limit?: number, deadline?: number): Promise<readonly RetentionDeleteResult[]>;
  /** Null expired payload captures in independently committed, bounded batches. */
  pruneExpiredCaptures(workspaceId: string, now: Date, maxBatches?: number, deadline?: number): Promise<number>;
  /** Delete hourly only after daily proof and daily only after monthly proof. */
  pruneExpiredAggregateGrains(workspaceId: string, now: Date, maxBatches?: number, deadline?: number): Promise<number>;
  /** Reclaim retained compacted-trace identities in independently committed, bounded batches. */
  pruneCompactedTraceProjections(workspaceId: string, maxBatches?: number, deadline?: number): Promise<number>;
  updateProgress(jobId: string, workspaceId: string, progress: CompactionProgress, deadline?: number): Promise<void>;
  fail(jobId: string, workspaceId: string, progress: CompactionProgress, blocker: CompactionBlocker, deadline?: number): Promise<void>;
  complete(jobId: string, workspaceId: string, progress: CompactionProgress, deadline?: number): Promise<void>;
}

export type CompactionResult =
  | { status: "contention"; code: "COMPACTION_IN_PROGRESS" }
  | { status: "not_found" }
  | { status: "blocked"; blocker: CompactionBlocker; beforeBytes: number; afterBytes: number; freedBytes: number }
  /** Work was durably checkpointed but deliberately left claimed for a later bounded fire. */
  | { status: "incomplete"; beforeBytes: number }
  | { status: "done"; beforeBytes: number; afterBytes: number; freedBytes: number };

export interface CompactionRunOptions {
  /** Epoch deadline owned by the serverless caller; no new unit starts after this point. */
  deadline?: number;
  /** Bounds each Cron fire to one resumable unit of each expensive class. */
  maxClosedHours?: number;
  maxPartitions?: number;
  maxMaintenanceBatches?: number;
}

export function progressFromPayload(payload: unknown): CompactionProgress {
  if (typeof payload !== "object" || payload === null) return { version: 1, steps: [] };
  const candidate = (payload as Record<string, unknown>).compaction;
  if (typeof candidate !== "object" || candidate === null) return { version: 1, steps: [] };
  const value = candidate as Partial<CompactionProgress>;
  const steps = Array.isArray(value.steps)
    ? value.steps.filter((step): step is CompactionStep => step === "measured_before" || step === "hourly_aggregated" || step === "aggregate_rollups" || step === "blocked" || step === "measured_after")
    : [];
  return { version: 1, steps, closedHour: value.closedHour,
    closedHours: Array.isArray(value.closedHours) ? value.closedHours.filter((v): v is string => typeof v === "string") : undefined,
    beforeBytes: value.beforeBytes, afterBytes: value.afterBytes, freedBytes: value.freedBytes, blocker: value.blocker,
    partitionOutcomes: Array.isArray(value.partitionOutcomes) ? value.partitionOutcomes as RetentionDeleteResult[] : undefined };
}

export function withStep(progress: CompactionProgress, step: CompactionStep): CompactionProgress {
  return progress.steps.includes(step) ? progress : { ...progress, steps: [...progress.steps, step] };
}

/**
 * A deliberately small state machine: aggregation is idempotent replacement, then the run fails
 * closed unless the database can prove configured retention and export/checkpoint prerequisites.
 * No method in this package emits partition DDL or touches immutable truth tables.
 */
export class StorageCompactor {
  constructor(private readonly repository: StorageRepository, private readonly now: () => Date = () => new Date()) {}

  async run(jobId: string, workspaceId: string, workerId: string, options: CompactionRunOptions = {}): Promise<CompactionResult> {
    if (!(await this.repository.tryLock(workspaceId, options.deadline))) return { status: "contention", code: "COMPACTION_IN_PROGRESS" };
    const job = await this.repository.claim(jobId, workspaceId, workerId, options.deadline);
    if (!job) return { status: "not_found" };

    let progress = progressFromPayload(job.payload);
    const beforeBytes = await this.repository.measure(options.deadline);
    progress = withStep({ ...progress, beforeBytes }, "measured_before");

    const incomplete = async (): Promise<CompactionResult> => {
      // Keep the job claimed and persist exactly what completed. The scheduler only rediscovers
      // a stale claim, so a deadline can never convert partial work into a false `done` state.
      try {
        await this.repository.updateProgress(job.id, workspaceId, progress, options.deadline);
      } catch (error) {
        // Durable unit operations persist their own checkpoints. If the invocation deadline has
        // expired, preserving the claim is sufficient for lease-based resumption.
        if (!(error instanceof CompactionDeferred)) throw error;
      }
      return { status: "incomplete", beforeBytes };
    };
    try {
      await this.repository.updateProgress(job.id, workspaceId, progress, options.deadline);
      const outOfTime = () => options.deadline !== undefined && Date.now() >= options.deadline;
      if (outOfTime()) return incomplete();

      const runNow = this.now();
      const closedHours = await this.repository.listUncheckpointedClosedHours(workspaceId, runNow, options.maxClosedHours, options.deadline);
      for (const closedHour of closedHours) {
        if (outOfTime()) return incomplete();
        await this.repository.aggregateClosedHour(workspaceId, closedHour, options.deadline);
      }
      const lastClosedHour = closedHours.at(-1);
      progress = withStep({
        ...progress,
        closedHour: lastClosedHour?.toISOString(),
        closedHours: closedHours.map((hour) => hour.toISOString()),
      }, "hourly_aggregated");
      await this.repository.updateProgress(job.id, workspaceId, progress, options.deadline);
      // A full bounded page is conservatively retried. The next fire sees the durable checkpoints
      // and either advances to the next unit or reaches a short final page before completion.
      if (options.maxClosedHours !== undefined && closedHours.length >= options.maxClosedHours) return incomplete();
      if (outOfTime()) return incomplete();
      await this.repository.rollupClosedWindows(workspaceId, runNow, options.deadline);
      progress = withStep(progress, "aggregate_rollups");
      await this.repository.updateProgress(job.id, workspaceId, progress, options.deadline);
      if (outOfTime()) return incomplete();

      const missing = await this.repository.retentionPrerequisites(workspaceId, options.deadline);
      if (missing.length > 0) {
        const afterBytes = await this.repository.measure(options.deadline);
        const blocker: CompactionBlocker = { code: "RETENTION_PREREQUISITES_MISSING", missing, destructiveWorkSkipped: true };
        progress = withStep({ ...progress, afterBytes, freedBytes: 0, blocker }, "blocked");
        await this.repository.fail(job.id, workspaceId, progress, blocker, options.deadline);
        return { status: "blocked", blocker, beforeBytes, afterBytes, freedBytes: 0 };
      }

      // `compactEligiblePartitions` owns the export/checkpoint/drop sequence. It only receives a
      // workspace id and has no API for arbitrary relation deletion. Projection pruning remains
      // independent so one failed partition cannot indefinitely retain expired trace identities.
      let partitionError: unknown;
      let outcomes: readonly RetentionDeleteResult[] = [];
      try {
        const maxMaintenanceBatches = options.maxMaintenanceBatches;
        const capturesPruned = await this.repository.pruneExpiredCaptures(workspaceId, runNow, maxMaintenanceBatches, options.deadline);
        if (maxMaintenanceBatches !== undefined && capturesPruned >= MAX_DELETE_BATCH_ROWS * maxMaintenanceBatches) return incomplete();
        if (outOfTime()) return incomplete();
        const aggregatesPruned = await this.repository.pruneExpiredAggregateGrains(workspaceId, runNow, maxMaintenanceBatches, options.deadline);
        if (maxMaintenanceBatches !== undefined && aggregatesPruned >= MAX_DELETE_BATCH_ROWS * maxMaintenanceBatches) return incomplete();
        if (outOfTime()) return incomplete();
        outcomes = await this.repository.compactEligiblePartitions(workspaceId, runNow, options.maxPartitions, options.deadline);
      } catch (error) {
        if (error instanceof CompactionDeferred) return incomplete();
        partitionError = error;
        outcomes = error instanceof PartitionCompactionError ? error.outcomes : progress.partitionOutcomes ?? [];
      }

      if (options.maxPartitions !== undefined && outcomes.length >= options.maxPartitions) {
        progress = { ...progress, partitionOutcomes: outcomes };
        return incomplete();
      }
      if (outOfTime()) return incomplete();

      try {
        const projectionsPruned = await this.repository.pruneCompactedTraceProjections(workspaceId, options.maxMaintenanceBatches, options.deadline);
        if (options.maxMaintenanceBatches !== undefined && projectionsPruned >= MAX_DELETE_BATCH_ROWS * options.maxMaintenanceBatches) return incomplete();
      } catch (pruneError) {
        if (pruneError instanceof CompactionDeferred) return incomplete();
        if (!partitionError) partitionError = pruneError;
      }

      if (partitionError) {
        const reason = partitionError instanceof Error ? partitionError.message : "unknown export or projection-prune failure";
        // A later partition can fail after earlier drops have committed. Re-measure instead of
        // claiming the entire run freed zero; that hid successful destructive work from callers.
        const measuredAfterFailure = await this.repository.measure(options.deadline);
        const freedBytes = Math.max(0, beforeBytes - measuredAfterFailure);
        const blocker: CompactionBlocker = {
          code: "EXPORT_VERIFICATION_FAILED",
          missing: [`export_verification:${reason}`],
          ...(outcomes?.length ? {} : { destructiveWorkSkipped: true }),
        };
        progress = withStep({ ...progress, afterBytes: measuredAfterFailure, freedBytes, blocker,
          partitionOutcomes: outcomes }, "blocked");
        await this.repository.fail(job.id, workspaceId, progress, blocker, options.deadline);
        return { status: "blocked", blocker, beforeBytes, afterBytes: measuredAfterFailure, freedBytes };
      }
      progress = { ...progress, partitionOutcomes: outcomes };
      await this.repository.updateProgress(job.id, workspaceId, progress, options.deadline);
      const measuredAfterDelete = await this.repository.measure(options.deadline);
      progress = withStep({ ...progress, afterBytes: measuredAfterDelete, freedBytes: Math.max(0, beforeBytes - measuredAfterDelete) }, "measured_after");
      await this.repository.complete(job.id, workspaceId, progress, options.deadline);
      return { status: "done", beforeBytes, afterBytes: measuredAfterDelete, freedBytes: progress.freedBytes ?? 0 };
    } catch (error) {
      if (error instanceof CompactionDeferred) return incomplete();
      throw error;
    }
  }
}
