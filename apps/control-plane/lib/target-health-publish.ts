// Durable executor for the coalesced target-health snapshot-publication intent.  Reduction owns
// evidence and projection state; this worker owns only the bounded, fenced side effect.
import { randomUUID } from "node:crypto";
import { publishHealthOnly } from "./snapshot";
import type { Sql } from "./db";

export const TARGET_HEALTH_PUBLICATION_LIMIT = 25;
export const TARGET_HEALTH_PUBLICATION_LEASE_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3_600;

async function withWorkspace<T>(workspaceId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const db = await import("./db");
  return db.withWorkspace(workspaceId, fn);
}

type ClaimedPublication = {
  id: string;
  installation_id: string | null;
  attempts: number;
  max_attempts: number;
  claimed_by: string;
};

export interface TargetHealthPublicationDrainResult {
  claimed: number;
  published: number;
  noop: number;
  retried: number;
  dead: number;
}

/** Capped exponential retry: 5s, 10s, ... up to one hour. */
export function targetHealthPublicationRetrySeconds(attempt: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, 5 * 2 ** Math.min(Math.max(attempt - 1, 0), 10));
}

/** Never persist provider/config error details in the tenant-visible job ledger. */
export function targetHealthPublicationError(): { code: "TARGET_HEALTH_PUBLICATION_FAILED" } {
  return { code: "TARGET_HEALTH_PUBLICATION_FAILED" };
}

async function claimTargetHealthPublication(workspaceId: string): Promise<ClaimedPublication | null> {
  return withWorkspace(workspaceId, async (sql) => {
    const fence = randomUUID();
    // Exhausted jobs are terminal even if a worker died while holding the last lease.  This is
    // deliberately separate from the claim CTE so a dead job cannot starve due work behind it.
    await sql`
      UPDATE job_ledger
      SET status = 'dead', claimed_at = NULL, claimed_by = NULL,
          last_error = ${sql.json({ code: "TARGET_HEALTH_PUBLICATION_MAX_ATTEMPTS" } as never)}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND kind = 'target_health_publish'
        AND attempts >= max_attempts AND status IN ('pending', 'claimed')
        AND (status = 'pending' OR claimed_at <= now() - ${TARGET_HEALTH_PUBLICATION_LEASE_SECONDS} * interval '1 second')`;
    const rows = await sql<ClaimedPublication[]>`
      WITH next AS (
        SELECT id
        FROM job_ledger
        WHERE workspace_id = ${workspaceId} AND kind = 'target_health_publish'
          AND run_after <= now() AND attempts < max_attempts
          AND (status = 'pending' OR (status = 'claimed' AND claimed_at <= now() - ${TARGET_HEALTH_PUBLICATION_LEASE_SECONDS} * interval '1 second'))
        ORDER BY run_after, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE job_ledger j
      SET status = 'claimed', claimed_at = now(), claimed_by = ${fence},
          attempts = attempts + 1, updated_at = now()
      FROM next
      WHERE j.id = next.id
      RETURNING j.id, j.payload->>'installationId' AS installation_id, j.attempts, j.max_attempts, j.claimed_by`;
    return rows[0] ?? null;
  });
}

type Completion = "done" | "retry" | "dead";

async function finishTargetHealthPublication(
  workspaceId: string,
  job: ClaimedPublication,
  completion: Completion,
): Promise<boolean> {
  return withWorkspace(workspaceId, async (sql) => {
    const isFailure = completion !== "done";
    const rows = await sql<{ id: string }[]>`
      UPDATE job_ledger
      SET status = ${completion === "done" ? "done" : completion === "dead" ? "dead" : "pending"},
          claimed_at = NULL, claimed_by = NULL,
          run_after = CASE WHEN ${completion === "retry"}
                           THEN now() + (${targetHealthPublicationRetrySeconds(job.attempts)}::text || ' seconds')::interval
                           ELSE run_after END,
          last_error = ${isFailure ? sql.json(targetHealthPublicationError() as never) : null},
          updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${job.id} AND kind = 'target_health_publish'
        AND status = 'claimed' AND claimed_by = ${job.claimed_by}
      RETURNING id`;
    return rows.length > 0;
  });
}

/**
 * Publish a bounded number of target-health overlays for one already-authorized workspace.
 * Every completion rechecks its random claim fence.  A lost fence never mutates the newer
 * claimant's job state; the external operation is independently idempotent/config-reconciled.
 */
export async function drainTargetHealthPublications(
  workspaceId: string,
  limit = 10,
): Promise<TargetHealthPublicationDrainResult> {
  const result: TargetHealthPublicationDrainResult = { claimed: 0, published: 0, noop: 0, retried: 0, dead: 0 };
  const bounded = Math.min(Math.max(1, limit), TARGET_HEALTH_PUBLICATION_LIMIT);
  for (let index = 0; index < bounded; index += 1) {
    const job = await claimTargetHealthPublication(workspaceId);
    if (!job) break;
    result.claimed += 1;
    try {
      if (!job.installation_id) throw new Error("target-health publication job missing installation id");
      const operation = await publishHealthOnly(workspaceId, job.installation_id);
      // `null` means the health overlay already matches the active signed snapshot.  An accepted
      // operation may leave accelerator delivery to config_publish_reconcile; durable acceptance
      // is the successful hand-off for this worker.
      if (operation === null) result.noop += 1;
      else if (operation.outcome === "accepted") result.published += 1;
      else throw new Error("target-health publication was not accepted");
      if (!await finishTargetHealthPublication(workspaceId, job, "done")) {
        // The newer owner gets to finish/retry.  Do not count a side effect whose lease we lost.
        result.published -= operation?.outcome === "accepted" ? 1 : 0;
        result.noop -= operation === null ? 1 : 0;
      }
    } catch {
      const completion: Completion = job.attempts >= job.max_attempts ? "dead" : "retry";
      const completed = await finishTargetHealthPublication(workspaceId, job, completion);
      if (completed && completion === "dead") result.dead += 1;
      else if (completed) result.retried += 1;
    }
  }
  return result;
}
