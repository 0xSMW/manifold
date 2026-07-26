// Durable, bounded target-health reduction. The gateway only appends authenticated attempt facts;
// this module is the control-plane side that turns that evidence into a small operational state.
import { createHash, randomUUID } from "node:crypto";
export type { ProviderAttemptHealthFactInput } from "@manifold/database";
export { recordProviderAttemptHealthFacts } from "@manifold/database";
import type { Sql } from "./db";

export type TargetHealthState = "healthy" | "degraded" | "unhealthy" | "unknown";
export type TargetHealthOutcome = "success" | "transient_failure" | "permanent_failure";

export const TARGET_HEALTH_WINDOW_MS = 5 * 60_000;
export const TARGET_HEALTH_EVIDENCE_TTL_MS = 120_000;
export const TARGET_HEALTH_RECOVERY_SUCCESSES = 3;
export const TARGET_HEALTH_JOB_LIMIT = 50;
const TARGET_HEALTH_LEASE_SECONDS = 60;

// Keep the reduction importable in bare Node tests. The Next-only DB module itself imports app
// aliases, so loading it lazily confines that resolution to the worker paths that actually use it.
async function withWorkspace<T>(workspaceId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const db = await import("./db");
  return db.withWorkspace(workspaceId, fn);
}

export interface TargetHealthEvidence {
  outcome: TargetHealthOutcome;
  occurredAt: Date;
}

export interface TargetHealthDecision {
  state: TargetHealthState;
  attempts: number;
  transientFailures: number;
  transientRatio: number;
  consecutiveSuccesses: number;
  lastEvidenceAt: Date | null;
}

/**
 * A pure, time-bounded transition. Evidence must be newest-first when supplied; the SQL query
 * below enforces that ordering and this helper defensively sorts it for direct callers/tests.
 */
export function deriveTargetHealth(input: {
  now: Date;
  previous: TargetHealthState;
  evidence: readonly TargetHealthEvidence[];
}): TargetHealthDecision {
  const floor = input.now.getTime() - TARGET_HEALTH_WINDOW_MS;
  const evidence = input.evidence
    .filter((item) => Number.isFinite(item.occurredAt.getTime()) && item.occurredAt.getTime() >= floor && item.occurredAt.getTime() <= input.now.getTime())
    .slice()
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  const lastEvidenceAt = evidence[0]?.occurredAt ?? null;
  if (!lastEvidenceAt || input.now.getTime() - lastEvidenceAt.getTime() > TARGET_HEALTH_EVIDENCE_TTL_MS) {
    return { state: "unknown", attempts: evidence.length, transientFailures: 0, transientRatio: 0, consecutiveSuccesses: 0, lastEvidenceAt };
  }
  const transientFailures = evidence.filter((item) => item.outcome === "transient_failure").length;
  const transientRatio = evidence.length === 0 ? 0 : transientFailures / evidence.length;
  let consecutiveSuccesses = 0;
  for (const item of evidence) {
    if (item.outcome !== "success") break;
    consecutiveSuccesses += 1;
  }
  const candidate: TargetHealthState = transientFailures >= 5 && evidence.length >= 5 && transientRatio >= 0.5
    ? "unhealthy"
    : transientRatio >= 0.5 ? "degraded" : "healthy";
  // Recovery evidence is intentionally ordered rather than ratio-based: once the literal newest
  // three qualifying attempts succeed, a target can re-enter service without waiting for older
  // failures to age out of the five-minute classification window. Any non-success (including a
  // permanent failure) breaks the run and therefore cannot contribute to recovery.
  const recovering = (input.previous === "unhealthy" || input.previous === "degraded")
    && consecutiveSuccesses >= TARGET_HEALTH_RECOVERY_SUCCESSES;
  const state = recovering
    ? "healthy"
    : candidate === "healthy" && (input.previous === "unhealthy" || input.previous === "degraded")
      ? input.previous
      : candidate;
  return { state, attempts: evidence.length, transientFailures, transientRatio, consecutiveSuccesses, lastEvidenceAt };
}

function stableJobId(kind: string, idempotencyKey: string): string {
  return `job_${kind}_${createHash("sha256").update(idempotencyKey).digest("base64url")}`;
}

/** Coalesce at-least-once attempt evidence into one target-local durable rollup job. */
export async function enqueueTargetHealthRollup(sql: Sql, workspaceId: string, installationId: string, targetId: string): Promise<void> {
  const idempotencyKey = `target_health_rollup:${targetId}`;
  await sql`
    INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
    VALUES (${stableJobId("target_health_rollup", idempotencyKey)}, ${workspaceId}, 'target_health_rollup',
      ${sql.json({ installationId, targetId } as never)}, ${idempotencyKey}, 'pending', 0, now(), now())
    ON CONFLICT (kind, idempotency_key) DO UPDATE
      SET status = CASE WHEN job_ledger.status IN ('done','dead') THEN 'pending' ELSE job_ledger.status END,
          attempts = CASE WHEN job_ledger.status IN ('done','dead') THEN 0 ELSE job_ledger.attempts END,
          run_after = CASE WHEN job_ledger.status IN ('done','dead') THEN now() ELSE job_ledger.run_after END,
          claimed_at = CASE WHEN job_ledger.status IN ('done','dead') THEN NULL ELSE job_ledger.claimed_at END,
          claimed_by = CASE WHEN job_ledger.status IN ('done','dead') THEN NULL ELSE job_ledger.claimed_by END,
          last_error = CASE WHEN job_ledger.status IN ('done','dead') THEN NULL ELSE job_ledger.last_error END,
          updated_at = now()`;
}

/** Publication execution belongs to the snapshot publisher; this only records a coalesced intent. */
export async function enqueueTargetHealthPublish(sql: Sql, workspaceId: string, installationId: string): Promise<void> {
  const idempotencyKey = `target_health_publish:${installationId}`;
  await sql`
    INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
    VALUES (${stableJobId("target_health_publish", idempotencyKey)}, ${workspaceId}, 'target_health_publish',
      ${sql.json({ installationId } as never)}, ${idempotencyKey}, 'pending', 0, now(), now())
    ON CONFLICT (kind, idempotency_key) DO UPDATE
      SET status = CASE WHEN job_ledger.status IN ('done','dead') THEN 'pending' ELSE job_ledger.status END,
          attempts = CASE WHEN job_ledger.status IN ('done','dead') THEN 0 ELSE job_ledger.attempts END,
          run_after = CASE WHEN job_ledger.status IN ('done','dead') THEN now() ELSE job_ledger.run_after END,
          claimed_at = CASE WHEN job_ledger.status IN ('done','dead') THEN NULL ELSE job_ledger.claimed_at END,
          claimed_by = CASE WHEN job_ledger.status IN ('done','dead') THEN NULL ELSE job_ledger.claimed_by END,
          last_error = CASE WHEN job_ledger.status IN ('done','dead') THEN NULL ELSE job_ledger.last_error END,
          updated_at = now()`;
}

type ClaimedRollup = { id: string; target_id: string; installation_id: string; attempts: number; claimed_by: string };
type ExistingHealth = { state: TargetHealthState; route_revision_id: string; snapshot_revision_id: string; last_observed_at: string | null };
type EvidenceRow = { outcome: TargetHealthOutcome; occurred_at: string; route_revision_id: string; snapshot_revision_id: string };

async function claimTargetHealthRollup(workspaceId: string): Promise<ClaimedRollup | null> {
  return withWorkspace(workspaceId, async (sql) => {
    const fence = randomUUID();
    await sql`
      UPDATE job_ledger
      SET status = 'dead', claimed_at = NULL, claimed_by = NULL,
          last_error = ${sql.json({ code: "TARGET_HEALTH_MAX_ATTEMPTS" } as never)}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND kind = 'target_health_rollup'
        AND attempts >= max_attempts AND status IN ('pending', 'claimed')
        AND (status = 'pending' OR claimed_at <= now() - ${TARGET_HEALTH_LEASE_SECONDS} * interval '1 second')`;
    const rows = await sql<ClaimedRollup[]>`
      WITH next AS (
        SELECT id
        FROM job_ledger
        WHERE workspace_id = ${workspaceId} AND kind = 'target_health_rollup'
          AND run_after <= now() AND attempts < max_attempts
          AND (status = 'pending' OR (status = 'claimed' AND claimed_at <= now() - ${TARGET_HEALTH_LEASE_SECONDS} * interval '1 second'))
        ORDER BY run_after, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE job_ledger j
      SET status = 'claimed', claimed_at = now(), claimed_by = ${fence}, attempts = attempts + 1, updated_at = now()
      FROM next
      WHERE j.id = next.id
      RETURNING j.id, j.payload->>'targetId' AS target_id, j.payload->>'installationId' AS installation_id, j.attempts, j.claimed_by`;
    return rows[0] ?? null;
  });
}

function retrySeconds(attempt: number): number { return Math.min(3_600, 5 * 2 ** Math.min(Math.max(attempt - 1, 0), 10)); }

async function finishTargetHealthRollup(workspaceId: string, job: ClaimedRollup, error?: unknown): Promise<boolean> {
  return withWorkspace(workspaceId, async (sql) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE job_ledger
      SET status = CASE WHEN ${Boolean(error)} AND attempts >= max_attempts THEN 'dead'
                        WHEN ${Boolean(error)} THEN 'pending' ELSE 'done' END,
          claimed_at = NULL, claimed_by = NULL,
          run_after = CASE WHEN ${Boolean(error)} AND attempts < max_attempts
                           THEN now() + (${retrySeconds(job.attempts)}::text || ' seconds')::interval
                           ELSE run_after END,
          last_error = ${error ? sql.json({ code: "TARGET_HEALTH_ROLLUP_FAILED" } as never) : null},
          updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${job.id} AND kind = 'target_health_rollup'
        AND status = 'claimed' AND claimed_by = ${job.claimed_by}
      RETURNING id`;
    return rows.length > 0;
  });
}

/** Expiry is evidence-driven too: no recent observation must actively publish `unknown`. */
async function expireTargetHealth(workspaceId: string, limit: number): Promise<number> {
  return withWorkspace(workspaceId, async (sql) => {
    const expired = await sql<{ installation_id: string }[]>`
      WITH due AS (
        SELECT target_id
        FROM gateway_target_health
        WHERE workspace_id = ${workspaceId} AND next_expiry_at <= now() AND state <> 'unknown'
        ORDER BY next_expiry_at, target_id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE gateway_target_health h
      SET state = 'unknown', state_changed_at = now(), last_rolled_up_at = now(),
          next_expiry_at = NULL, updated_at = now()
      FROM due
      WHERE h.workspace_id = ${workspaceId} AND h.target_id = due.target_id
      RETURNING h.installation_id`;
    for (const installationId of new Set(expired.map((row) => row.installation_id))) {
      await enqueueTargetHealthPublish(sql, workspaceId, installationId);
    }
    return expired.length;
  });
}

/**
 * Claim and reduce a bounded number of target jobs for one already-authorized workspace. A target
 * row is locked while its projection changes; facts are append-only and are bounded by the 5-minute
 * query. `target_health_publish` is enqueued only when the materialized state actually changes.
 */
export async function drainTargetHealthRollups(workspaceId: string, limit = 10): Promise<{ claimed: number; rolledUp: number; changed: number; retried: number }> {
  const result = { claimed: 0, rolledUp: 0, changed: 0, retried: 0 };
  result.changed += await expireTargetHealth(workspaceId, Math.min(Math.max(1, limit), TARGET_HEALTH_JOB_LIMIT));
  for (let index = 0; index < Math.min(Math.max(1, limit), TARGET_HEALTH_JOB_LIMIT); index += 1) {
    const job = await claimTargetHealthRollup(workspaceId);
    if (!job) break;
    result.claimed += 1;
    try {
      const changed = await withWorkspace(workspaceId, async (sql) => {
        // Serialise this target's projection even if a lease is reclaimed while an older worker is
        // still unwinding. The parent route/revision join also makes a forged target id a no-op.
        const target = await sql<{ id: string; installation_id: string }[]>`
          SELECT t.id, r.installation_id
          FROM gateway_target t
          JOIN gateway_route_revision rr ON rr.id = t.route_revision_id AND rr.workspace_id = t.workspace_id
          JOIN gateway_route r ON r.id = rr.route_id AND r.workspace_id = rr.workspace_id
          WHERE t.workspace_id = ${workspaceId} AND t.id = ${job.target_id}
            AND r.installation_id = ${job.installation_id}
          FOR UPDATE OF t`;
        if (!target[0]) return false;
        const prior = await sql<ExistingHealth[]>`
          SELECT state, route_revision_id, snapshot_revision_id, last_observed_at::text
          FROM gateway_target_health
          WHERE workspace_id = ${workspaceId} AND target_id = ${job.target_id}
          FOR UPDATE`;
        const facts = await sql<EvidenceRow[]>`
          SELECT outcome, occurred_at::text, route_revision_id, snapshot_revision_id
          FROM gateway_target_health_observation
          WHERE workspace_id = ${workspaceId} AND target_id = ${job.target_id}
            AND occurred_at >= now() - interval '5 minutes' AND occurred_at <= now()
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1000`;
        const latest = await sql<EvidenceRow[]>`
          SELECT outcome, occurred_at::text, route_revision_id, snapshot_revision_id
          FROM gateway_target_health_observation
          WHERE workspace_id = ${workspaceId} AND target_id = ${job.target_id}
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`;
        const nowRows = await sql<{ now: string }[]>`SELECT now()::text AS now`;
        const decision = deriveTargetHealth({
          now: new Date(nowRows[0]!.now),
          previous: prior[0]?.state ?? "unknown",
          evidence: facts.map((fact) => ({ outcome: fact.outcome, occurredAt: new Date(fact.occurred_at) })),
        });
        const identity = latest[0] ?? prior[0];
        // A coalesced/replayed job can legitimately have no fact (for example, after retention).
        // Never try to invent non-null FK provenance for a projection in that case.
        if (!identity) return false;
        const permanentFailures = facts.filter((fact) => fact.outcome === "permanent_failure").length;
        const successes = facts.filter((fact) => fact.outcome === "success").length;
        let consecutiveFailures = 0;
        for (const fact of facts) {
          if (fact.outcome !== "transient_failure") break;
          consecutiveFailures += 1;
        }
        const before = prior[0]?.state ?? "unknown";
        await sql`
          INSERT INTO gateway_target_health
            (target_id, workspace_id, installation_id, route_revision_id, snapshot_revision_id,
             state, window_started_at, window_ended_at, sample_count, success_count,
             transient_failure_count, permanent_failure_count, consecutive_successes,
             consecutive_failures, last_outcome, last_observed_at, state_changed_at,
             last_rolled_up_at, next_expiry_at, created_at, updated_at)
          VALUES (${job.target_id}, ${workspaceId}, ${job.installation_id},
             (SELECT route_revision_id FROM gateway_target WHERE workspace_id = ${workspaceId} AND id = ${job.target_id}),
             ${identity.snapshot_revision_id},
             ${decision.state}, now() - interval '5 minutes', now(), ${decision.attempts}, ${successes},
             ${decision.transientFailures}, ${permanentFailures}, ${decision.consecutiveSuccesses}, ${consecutiveFailures},
             ${facts[0]?.outcome ?? latest[0]?.outcome ?? null}, ${decision.lastEvidenceAt?.toISOString() ?? prior[0]?.last_observed_at ?? null},
             now(), now(), ${decision.state === "unknown" ? null : new Date((decision.lastEvidenceAt ?? new Date(prior[0]?.last_observed_at ?? nowRows[0]!.now)).getTime() + TARGET_HEALTH_EVIDENCE_TTL_MS).toISOString()}, now(), now())
          ON CONFLICT (target_id) DO UPDATE
            SET installation_id = EXCLUDED.installation_id, route_revision_id = EXCLUDED.route_revision_id,
                snapshot_revision_id = EXCLUDED.snapshot_revision_id, state = EXCLUDED.state,
                window_started_at = EXCLUDED.window_started_at, window_ended_at = EXCLUDED.window_ended_at,
                sample_count = EXCLUDED.sample_count, success_count = EXCLUDED.success_count,
                transient_failure_count = EXCLUDED.transient_failure_count,
                permanent_failure_count = EXCLUDED.permanent_failure_count,
                consecutive_successes = EXCLUDED.consecutive_successes,
                consecutive_failures = EXCLUDED.consecutive_failures, last_outcome = EXCLUDED.last_outcome,
                last_observed_at = EXCLUDED.last_observed_at,
                state_changed_at = CASE WHEN gateway_target_health.state = EXCLUDED.state THEN gateway_target_health.state_changed_at ELSE now() END,
                last_rolled_up_at = now(), next_expiry_at = EXCLUDED.next_expiry_at, updated_at = now()`;
        if (decision.state !== before) await enqueueTargetHealthPublish(sql, workspaceId, job.installation_id);
        return decision.state !== before;
      });
      result.rolledUp += 1;
      if (changed) result.changed += 1;
      await finishTargetHealthRollup(workspaceId, job);
    } catch (error) {
      result.retried += 1;
      await finishTargetHealthRollup(workspaceId, job, error);
    }
  }
  return result;
}
