// Database-only admission of authenticated provider-attempt facts into durable target health.
// Callers MUST already be in a transaction with manifold.workspace_id set locally.
import { createHash } from "node:crypto";
import type { WorkspaceScopedSql } from "./index.js";

export type ProviderAttemptHealthOutcome = "success" | "transient_failure" | "permanent_failure";

export interface ProviderAttemptHealthFactInput {
  /** Stable observation-event id, never a caller-selected health row id. */
  sourceEventId: string;
  targetId: string;
  routeRevisionId: string;
  snapshotRevisionId: string;
  outcome: ProviderAttemptHealthOutcome;
  httpStatus: number | null;
  reasonCodes: readonly string[];
  occurredAt: string;
}

function stableId(kind: string, value: string): string {
  return `job_${kind}_${createHash("sha256").update(value).digest("base64url")}`;
}

async function enqueueTargetHealthRollup(
  sql: WorkspaceScopedSql,
  workspaceId: string,
  installationId: string,
  targetId: string,
): Promise<void> {
  const idempotencyKey = `target_health_rollup:${targetId}`;
  await sql`
    INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
    VALUES (${stableId("target_health_rollup", idempotencyKey)}, ${workspaceId}, 'target_health_rollup',
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

/**
 * Append only facts that still belong to the authenticated installation's active route revision
 * and active signed snapshot. Invalid, stale, forged, and replayed attempts do not mutate health.
 */
export async function recordProviderAttemptHealthFacts(
  sql: WorkspaceScopedSql,
  workspaceId: string,
  installationId: string,
  facts: readonly ProviderAttemptHealthFactInput[],
): Promise<number> {
  let accepted = 0;
  for (const fact of facts.slice(0, 100)) {
    if (!fact.sourceEventId || !fact.targetId || !fact.routeRevisionId || !fact.snapshotRevisionId
      || !Number.isFinite(Date.parse(fact.occurredAt))) continue;
    const httpStatus = fact.httpStatus !== null && Number.isInteger(fact.httpStatus) && fact.httpStatus >= 100 && fact.httpStatus <= 599
      ? fact.httpStatus : null;
    const inserted = await sql<{ target_id: string }[]>`
      INSERT INTO gateway_target_health_observation
        (id, workspace_id, installation_id, target_id, route_revision_id, snapshot_revision_id,
         source_event_id, outcome, http_status, reason_codes, occurred_at, created_at)
      SELECT ${stableId("target_health_fact", `${workspaceId}:${installationId}:${fact.sourceEventId}`)}, ${workspaceId}, ${installationId},
             t.id, rr.id, cr.id, ${fact.sourceEventId}, ${fact.outcome}, ${httpStatus},
             ${sql.json([...fact.reasonCodes] as never)}, ${fact.occurredAt}, now()
      FROM gateway_target t
      JOIN gateway_route_revision rr ON rr.id = t.route_revision_id AND rr.workspace_id = t.workspace_id
      JOIN gateway_route r ON r.id = rr.route_id AND r.workspace_id = rr.workspace_id
      JOIN gateway_config_revision cr ON cr.id = ${fact.snapshotRevisionId}
        AND cr.workspace_id = ${workspaceId} AND cr.installation_id = ${installationId} AND cr.status = 'active'
      WHERE t.workspace_id = ${workspaceId} AND t.id = ${fact.targetId}
        AND rr.id = ${fact.routeRevisionId} AND r.installation_id = ${installationId}
        AND r.active_revision_id = rr.id
      ON CONFLICT (workspace_id, source_event_id) DO NOTHING
      RETURNING target_id`;
    if (!inserted[0]) continue;
    await enqueueTargetHealthRollup(sql, workspaceId, installationId, inserted[0].target_id);
    accepted += 1;
  }
  return accepted;
}
