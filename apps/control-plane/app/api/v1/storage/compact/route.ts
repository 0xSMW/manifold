// POST /api/v1/storage/compact — serialize and durably queue a manual compaction request.
import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { genId } from "@/lib/ids";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { StorageContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "storage:write");
    requireMutationIdempotencyKey(req);
    await contractBody(req.clone(), StorageContracts.compact);
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 5, windowMs: 60_000 }, handler: async (sql) => {
    const result = await (async () => {
      // xact lock is deliberately transaction-scoped: a request can only create one queue entry
      // after it has proved no pending/claimed compaction exists for this workspace.
      const lock = (await sql<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext('compact:' || ${principal.workspaceId})) AS acquired`)[0];
      if (!lock?.acquired) return { contention: true as const };
      const active = (await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM job_ledger
        WHERE workspace_id = ${principal.workspaceId} AND kind = 'storage.compact'
          AND status IN ('pending', 'claimed')
        ORDER BY created_at DESC LIMIT 1`)[0];
      if (active) return { contention: true as const, job: active };
      const id = genId("job");
      await sql`
        INSERT INTO job_ledger (id, workspace_id, kind, payload, status, run_after, created_at, updated_at)
        VALUES (${id}, ${principal.workspaceId}, 'storage.compact',
          ${sql.json({ requestedBy: principal.actorId, requestedAt: new Date().toISOString(), requestId })},
          'pending', now(), now(), now())`;
      await audit(sql, principal, {
        action: "storage.compact.request", targetKind: "job_ledger", targetId: id, requestId,
        detail: { status: "queued" },
      });
      return { contention: false as const, job: { id, status: "pending" } };
    })();
    if (result.contention) {
      throw new ManifoldError({ status: 409, code: "VALIDATION", message: "a storage compaction is already in progress", reasonCodes: ["COMPACTION_IN_PROGRESS"], retryable: true, details: result.job ? { jobId: result.job.id, status: result.job.status } : undefined });
    }
    // No compactor exists in this service yet; report only the durable queue state, never bytes.
    return contractOk(StorageContracts.compactResponse, { jobId: result.job.id, status: "queued", freedBytes: null }, requestId, 202);
    }});
  });
}
