// POST /api/v1/config/apply (SPEC §10.3 config:write, §8.2 apply(), §16.2 optimistic concurrency).
//
// Rebuilds the plan (deterministic), asserts the caller's planHash still matches (else the base
// moved → CONFIG_PRECONDITION_FAILED), holds destructive changes without approval
// (CONFIG_TRIPWIRE_HELD), then applies in one txn: inserts the new active
// gateway_config_revision (source of truth) and publishes to the store. Returns the new revision.
import { apply } from "@manifold/config";
import { authorize } from "@/lib/auth";
import { db, requireInstallation } from "@/lib/db";
import { buildSignedPlan, snapshotStore } from "@/lib/snapshot";
import {
  wrapInEnvelope,
  jsonBody,
  ok,
  requireString,
  optionalStringArray,
  ManifoldError,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:write");
    const body = await jsonBody(req);
    const installationId = requireString(body, "installationId");
    const expectedPlanHash = requireString(body, "planHash");
    const approvals = optionalStringArray(body, "approvals");

    // Installation must belong to this workspace.
    await requireInstallation(principal.workspaceId, installationId);

    const plan = await buildSignedPlan(principal.workspaceId, installationId);

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

    // Destructive changes require approval (§8.2 tripwires). Each tripwire item must be EXPLICITLY
    // approved by its ref — a non-empty-but-unrelated approvals array (e.g. ["dummy"]) must NOT
    // clear the hold. Hold unless EVERY tripwire item's ref appears in `approvals`.
    const approvedRefs = new Set(approvals);
    const unapprovedTripwires = plan.tripwireItems.filter((it) => !approvedRefs.has(it.ref));
    if (unapprovedTripwires.length > 0) {
      throw new ManifoldError({
        status: 422,
        code: "CONFIG_TRIPWIRE_HELD",
        message: "destructive changes require approval",
        reasonCodes: ["CONFIG_TRIPWIRE_HELD"],
        remediation: "re-apply with `approvals` listing the `ref` of each tripwire item shown",
        details: { items: unapprovedTripwires as unknown as Record<string, unknown>[] },
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
