// Durable Postgres job ledger primitives for gateway background work (§6.12 / ADR-0017).
// This module deliberately owns only queue mechanics. The observation reducer remains in observe.ts
// and is supplied here as a handler, so Vercel Cron and any future worker use the same ledger.
import { setWorkspaceGuc, type Sql, type TransactionSql } from "@manifold/database";
import { ulid } from "@manifold/ids";
import type { HotPathObservationEvent } from "@manifold/ports";

/** Stable persisted name. Do not rename: existing jobs use this as their dispatch contract. */
export const OBSERVATION_INGEST_JOB_KIND = "observation.ingest.v1" as const;

export type JobLedgerStatus = "pending" | "claimed" | "done" | "failed" | "dead";

/** Complete, already-collected trace sent to the durable ingest worker. */
export interface ObservationIngestJobPayload {
  version: 1;
  workspaceId: string;
  producerId: string;
  events: readonly HotPathObservationEvent[];
}

export interface JobLedgerJob {
  id: string;
  workspaceId: string;
  kind: typeof OBSERVATION_INGEST_JOB_KIND;
  payload: unknown;
  idempotencyKey: string | null;
  status: JobLedgerStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
}

interface ClaimedJobRow {
  id: string;
  workspace_id: string;
  kind: string;
  payload: unknown;
  idempotency_key: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  claimed_at: Date | null;
  claimed_by: string | null;
}

export interface RedactedJobError {
  code: string;
  message: string;
}

export interface JobLedgerDrainSummary {
  claimed: number;
  completed: number;
  retried: number;
  dead: number;
}

export interface JobLedgerBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A deterministic, injected adjustment in milliseconds. It is clamped to [0, maxDelayMs]. */
  jitter?: (attempt: number, cappedDelayMs: number) => number;
}

export interface JobLedgerServiceOptions extends JobLedgerBackoffOptions {
  sql: Sql;
  /** Injected so retry and stale-claim tests do not depend on wall time. */
  now?: () => Date;
  /** A claim older than this can be recovered by another drain. */
  claimTimeoutMs?: number;
  observationIngestHandler: (
    payload: ObservationIngestJobPayload,
    job: JobLedgerJob,
  ) => Promise<void>;
}

export interface EnqueueObservationIngestInput extends ObservationIngestJobPayload {
  /** Optional explicit anchor. Defaults to the trace id after payload validation. */
  idempotencyKey?: string;
  maxAttempts?: number;
  runAfter?: Date;
}

export interface EnqueueResult {
  id: string | null;
  enqueued: boolean;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 5 * 60_000;
const MAX_BATCH_SIZE = 100;

/** Exponential retry delay with a bounded, injectable jitter function. */
export function jobBackoffMs(attempt: number, options: JobLedgerBackoffOptions = {}): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new Error("backoff delays must be finite non-negative numbers");
  }
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 52));
  const adjusted = capped + (options.jitter?.(attempt, capped) ?? 0);
  return Math.min(maxDelayMs, Math.max(0, Math.floor(adjusted)));
}

/** Keep durable errors useful without retaining credentials, DSNs, or stack traces. */
export function redactJobError(error: unknown): RedactedJobError {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : "job handler failed";
  const message = source
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"`]+/gi, "[REDACTED_DSN]")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]")
    .slice(0, 1_000);
  const name = error instanceof Error ? error.name : "JobHandlerError";
  return { code: name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "JobHandlerError", message };
}

/** Runtime boundary for jsonb jobs: a worker never sends malformed data to the reducer. */
export function validateObservationIngestPayload(value: unknown): ObservationIngestJobPayload {
  if (!isRecord(value) || value.version !== 1 || !nonEmptyString(value.workspaceId) || !nonEmptyString(value.producerId)) {
    throw new Error("invalid observation ingest payload identity");
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    throw new Error("observation ingest payload must contain trace events");
  }
  const events = value.events as HotPathObservationEvent[];
  const traceId = events[0]?.traceId;
  if (!nonEmptyString(traceId) || !events.every(isCompleteObservationEvent)) {
    throw new Error("observation ingest payload contains an invalid trace event");
  }
  if (!events.every((event) => event.traceId === traceId)) {
    throw new Error("observation ingest payload must contain one trace");
  }
  const seqs = new Set(events.map((event) => event.seq));
  if (seqs.size !== events.length || events.filter((event) => event.kind === "terminal").length !== 1) {
    throw new Error("observation ingest payload must contain unique sequences and exactly one terminal event");
  }
  return { version: 1, workspaceId: value.workspaceId, producerId: value.producerId, events };
}

export class JobLedgerService {
  private readonly sql: Sql;
  private readonly now: () => Date;
  private readonly claimTimeoutMs: number;
  private readonly handler: JobLedgerServiceOptions["observationIngestHandler"];
  private readonly backoff: JobLedgerBackoffOptions;

  constructor(options: JobLedgerServiceOptions) {
    this.sql = options.sql;
    this.now = options.now ?? (() => new Date());
    this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
    this.handler = options.observationIngestHandler;
    this.backoff = {
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      jitter: options.jitter,
    };
  }

  /** Insert a complete trace once. The transaction scopes RLS before the write. */
  async enqueueObservationIngest(input: EnqueueObservationIngestInput): Promise<EnqueueResult> {
    const payload = validateObservationIngestPayload(input);
    if (input.workspaceId !== payload.workspaceId) throw new Error("workspace mismatch");
    const traceId = payload.events[0]!.traceId;
    const idempotencyKey =
      input.idempotencyKey ?? `workspace:${payload.workspaceId}:trace:${traceId}`;
    if (!nonEmptyString(idempotencyKey)) throw new Error("idempotencyKey must be non-empty");
    const maxAttempts = input.maxAttempts ?? 12;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
    const id = ulid(this.now().getTime());
    const runAfter = input.runAfter ?? this.now();
    const rows = await this.sql.begin(async (tx) => {
      await setWorkspaceGuc(tx, payload.workspaceId);
      return tx<{ id: string }[]>`
        INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key, max_attempts, run_after)
        VALUES (${id}, ${payload.workspaceId}, ${OBSERVATION_INGEST_JOB_KIND}, ${tx.json(payload as never)},
                ${idempotencyKey}, ${maxAttempts}, ${runAfter})
        ON CONFLICT (kind, idempotency_key) DO NOTHING
        RETURNING id
      `;
    });
    return { id: rows[0]?.id ?? null, enqueued: rows.length === 1 };
  }

  /** Claim a bounded due batch atomically; expired claims are reset before SKIP LOCKED selection. */
  async claim(workspaceId: string, workerId: string, batchSize = 25): Promise<JobLedgerJob[]> {
    assertBatch(batchSize);
    if (!nonEmptyString(workspaceId) || !nonEmptyString(workerId)) throw new Error("workspaceId and workerId are required");
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.claimTimeoutMs);
    const rows = await this.sql.begin(async (tx) => {
      await setWorkspaceGuc(tx, workspaceId);
      await tx`
        UPDATE job_ledger
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL, run_after = LEAST(run_after, ${now}), updated_at = ${now}
        WHERE workspace_id = ${workspaceId} AND status = 'claimed' AND claimed_at < ${staleBefore}
      `;
      return tx<ClaimedJobRow[]>`
        WITH due AS (
          SELECT id
          FROM job_ledger
          WHERE workspace_id = ${workspaceId}
            AND kind = ${OBSERVATION_INGEST_JOB_KIND}
            AND status = 'pending'
            AND run_after <= ${now}
          ORDER BY run_after ASC, created_at ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE job_ledger AS job
        SET status = 'claimed', claimed_at = ${now}, claimed_by = ${workerId}, updated_at = ${now}
        FROM due
        WHERE job.id = due.id
        RETURNING job.id, job.workspace_id, job.kind, job.payload, job.idempotency_key,
                  job.status, job.attempts, job.max_attempts, job.run_after, job.claimed_at, job.claimed_by
      `;
    });
    return rows.map(toJobLedgerJob);
  }

  /** Drain one claimed batch. A failure is recorded per job and cannot abort its neighbours. */
  async drain(workspaceId: string, workerId: string, batchSize = 25): Promise<JobLedgerDrainSummary> {
    const jobs = await this.claim(workspaceId, workerId, batchSize);
    const summary: JobLedgerDrainSummary = { claimed: jobs.length, completed: 0, retried: 0, dead: 0 };
    for (const job of jobs) {
      try {
        await this.process(job);
        await this.markDone(job, workerId);
        summary.completed += 1;
      } catch (error) {
        const status = await this.markFailure(job, workerId, error);
        if (status === "dead") summary.dead += 1;
        else summary.retried += 1;
      }
    }
    return summary;
  }

  private async process(job: JobLedgerJob): Promise<void> {
    if (job.kind !== OBSERVATION_INGEST_JOB_KIND) throw new Error(`unsupported job kind: ${job.kind}`);
    const payload = validateObservationIngestPayload(job.payload);
    if (payload.workspaceId !== job.workspaceId) throw new Error("job workspace does not match payload workspace");
    await this.handler(payload, job);
  }

  private async markDone(job: JobLedgerJob, workerId: string): Promise<void> {
    const now = this.now();
    await this.sql.begin(async (tx) => {
      await setWorkspaceGuc(tx, job.workspaceId);
      await tx`
        UPDATE job_ledger
        SET status = 'done', claimed_at = NULL, claimed_by = NULL, updated_at = ${now}
        WHERE id = ${job.id} AND workspace_id = ${job.workspaceId}
          AND status = 'claimed' AND claimed_by = ${workerId}
      `;
    });
  }

  private async markFailure(job: JobLedgerJob, workerId: string, error: unknown): Promise<"pending" | "dead"> {
    const now = this.now();
    const attempts = job.attempts + 1;
    const status = attempts >= job.maxAttempts ? "dead" : "pending";
    const runAfter = new Date(now.getTime() + jobBackoffMs(attempts, this.backoff));
    const lastError = redactJobError(error);
    await this.sql.begin(async (tx) => {
      await setWorkspaceGuc(tx, job.workspaceId);
      await tx`
        UPDATE job_ledger
        SET attempts = attempts + 1,
            status = ${status},
            run_after = ${runAfter},
            claimed_at = NULL,
            claimed_by = NULL,
            last_error = ${tx.json(lastError as never)},
            updated_at = ${now}
        WHERE id = ${job.id} AND workspace_id = ${job.workspaceId}
          AND status = 'claimed' AND claimed_by = ${workerId}
      `;
    });
    return status;
  }
}

function toJobLedgerJob(row: ClaimedJobRow): JobLedgerJob {
  if (row.kind !== OBSERVATION_INGEST_JOB_KIND || !isJobStatus(row.status)) throw new Error("unexpected claimed job row");
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
  };
}

function assertBatch(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJobStatus(value: string): value is JobLedgerStatus {
  return value === "pending" || value === "claimed" || value === "done" || value === "failed" || value === "dead";
}

function isCompleteObservationEvent(value: unknown): value is HotPathObservationEvent {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.traceId) &&
    (value.kind === "accepted" || value.kind === "provider_attempt" || value.kind === "terminal") &&
    typeof value.seq === "number" && Number.isInteger(value.seq) && value.seq >= 0 &&
    nonEmptyString(value.occurredAt) && !Number.isNaN(Date.parse(value.occurredAt)) &&
    nonEmptyString(value.profileId) &&
    (typeof value.keyId === "string" || value.keyId === null) &&
    (typeof value.routeId === "string" || value.routeId === null) &&
    (typeof value.offeringId === "string" || value.offeringId === null) &&
    (typeof value.status === "number" || value.status === null) &&
    Array.isArray(value.reasonCodes) && value.reasonCodes.every((code) => typeof code === "string")
  );
}
