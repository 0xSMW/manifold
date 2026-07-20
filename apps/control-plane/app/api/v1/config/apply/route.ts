// POST /api/v1/config/apply (SPEC §10.3 config:write, §8.2 apply(), §16.2 optimistic concurrency).
//
// Rebuilds the plan (deterministic), asserts the caller's planHash still matches (else the base
// moved → CONFIG_PRECONDITION_FAILED), holds destructive changes without approval
// (CONFIG_TRIPWIRE_HELD), then applies in one txn: inserts the new active
// gateway_config_revision (source of truth) and publishes to the store. Returns the new revision.
import { buildSnapshot, planApply, apply } from "@manifold/config";
import { authorize } from "@/lib/auth";
import { db, withWorkspace } from "@/lib/db";
import { signSnapshot, snapshotStore } from "@/lib/snapshot";
import { handle, jsonBody, ok, requireString, ManifoldError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "config:write");
    const body = await jsonBody(req);
    const installationId = requireString(body, "installationId");
    const expectedPlanHash = requireString(body, "planHash");
    const approvals = Array.isArray(body.approvals)
      ? (body.approvals as unknown[]).map(String)
      : [];

    // Installation must belong to this workspace.
    const inst = await withWorkspace(principal.workspaceId, (sql) =>
      sql<{ id: string }[]>`
        SELECT id FROM gateway_installation
        WHERE id = ${installationId} AND workspace_id = ${principal.workspaceId} LIMIT 1`,
    );
    if (!inst[0]) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "installation not found",
        reasonCodes: [],
      });
    }

    const built = await buildSnapshot(db(), installationId);
    const signed = signSnapshot(built);
    const plan = await planApply(db(), installationId, signed);

    // Optimistic-concurrency precondition on the plan the caller planned against (§16.2).
    if (plan.planHash !== expectedPlanHash) {
      throw new ManifoldError({
        status: 409,
        code: "CONFIG_PRECONDITION_FAILED",
        message: "active revision advanced since plan; re-plan and retry",
        reasonCodes: ["CONFIG_PRECONDITION_FAILED"],
        remediation: "re-run plan against the current active revision, then apply",
        retryable: true,
        details: { expected: expectedPlanHash, actual: plan.planHash },
      });
    }

    // Destructive changes require approval (§8.2 tripwires).
    if (plan.tripwireItems.length > 0 && approvals.length === 0) {
      throw new ManifoldError({
        status: 422,
        code: "CONFIG_TRIPWIRE_HELD",
        message: "destructive changes require approval",
        reasonCodes: ["CONFIG_TRIPWIRE_HELD"],
        remediation: "re-apply with `approvals` covering the listed tripwire items",
        details: { items: plan.tripwireItems as unknown as Record<string, unknown>[] },
      });
    }

    const op = await apply(db(), plan, snapshotStore());

    if (op.outcome === "rejected" && op.reasonCode === "CONFIG_PRECONDITION_FAILED") {
      throw new ManifoldError({
        status: 409,
        code: "CONFIG_PRECONDITION_FAILED",
        message: "active revision advanced during apply",
        reasonCodes: ["CONFIG_PRECONDITION_FAILED"],
        remediation: "re-run plan against the current active revision, then apply",
        retryable: true,
        details: { expected: plan.baseConfigHash, actual: op.baseConfigHash },
      });
    }

    return ok(
      {
        revisionId: op.revisionId,
        edgeConfigVersion: op.edgeConfigVersion,
        activeContentHash: op.targetConfigHash,
        outcome: op.outcome,
        noop: plan.noop,
      },
      requestId,
    );
  });
}
