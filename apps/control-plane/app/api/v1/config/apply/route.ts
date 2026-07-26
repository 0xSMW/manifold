// POST /api/v1/config/apply (SPEC §10.3 config:write, §8.2 apply(), §16.2 optimistic concurrency).
//
// Rebuilds the plan (deterministic), asserts the caller's planHash still matches (else the base
// moved → CONFIG_PRECONDITION_FAILED), holds destructive changes without approval
// (CONFIG_TRIPWIRE_HELD), then applies in one txn: inserts the new active
// gateway_config_revision (source of truth) and publishes to the store. Returns the new revision.
import { apply } from "@manifold/config";
import { authorize } from "@/lib/auth";
import { db, requireInstallation, withWorkspace } from "@/lib/db";
import { mutationOperationKey, runPostCommitMutationGuard } from "@/lib/mutation-guard";
import { buildSignedPlan, reconcileConfigOperation, snapshotStore } from "@/lib/snapshot";
import { contractBody, contractOk } from "@/lib/contracts";
import { ConfigContracts } from "@manifold/contracts";
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
    return runPostCommitMutationGuard({
      request: req,
      principal,
      requestId,
      // Apply can activate a new revision and drive an accelerator publication.
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async () => {
    const body = await contractBody(req, ConfigContracts.apply);
    const installationId = body.installationId;
    const expectedPlanHash = body.planHash;
    const approvalIds = body.approvalIds ?? [];

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
    if (
      plan.tripwireItems.length > 0 &&
      (principal.actorKind !== "member" ||
        !principal.member ||
        !["owner", "admin"].includes(principal.member.role))
    ) {
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "destructive config apply requires an admin or owner browser session",
        reasonCodes: [],
        remediation: "sign in as a workspace admin or owner and approve this exact plan",
      });
    }

    const publishStore = snapshotStore(plan.snapshot);
    // Request strings never become approvals. apply() locks and consumes persisted approval rows
    // bound to this workspace, installation, plan hash, kind/ref, member and expiry.
    const op = await apply(db().$client, plan, publishStore, [], {
      actorKind: principal.actorKind,
      actorId: principal.actorId,
      memberId: principal.member?.id,
      approvalIds,
      requestId,
      mutationKey: mutationOperationKey(req, principal),
    });

    // apply() committed the active revision and durable job before returning.  Dispatch once here
    // for low publish latency; a timeout/failure is already retained as pending/reconciliation
    // work, so this request never makes durability depend on the best-effort immediate attempt.
    if (op.outcome === "accepted" && op.revisionId && publishStore) {
      try { await reconcileConfigOperation(principal.workspaceId, op.id); } catch { /* cron/manual recovery owns retries */ }
    }

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
    if (op.outcome === "rejected" && op.reasonCode === "CONFIG_TRIPWIRE_HELD") {
      throw new ManifoldError({
        status: 422,
        code: "CONFIG_TRIPWIRE_HELD",
        message: "destructive changes require live persisted approvals for this exact plan",
        reasonCodes: ["CONFIG_TRIPWIRE_HELD"],
        remediation: "approve the current tripwire plan as an admin or owner, then retry once",
        details: { items: plan.tripwireItems as unknown as Record<string, unknown>[] },
      });
    }
    const statuses = await withWorkspace(principal.workspaceId, (sql) =>
      sql<{
        serving_mode: "boot_fallback" | "edge_config";
        accelerator_status: string;
      }[]>`
        SELECT serving_mode, accelerator_status
        FROM config_operation
        WHERE id = ${op.id} AND workspace_id = ${principal.workspaceId}
        LIMIT 1`,
    );
    const publication = statuses[0] ?? {
      serving_mode: "boot_fallback" as const,
      accelerator_status: "not_configured",
    };

    return contractOk(ConfigContracts.applyResponse,
      {
        revisionId: op.revisionId,
        edgeConfigVersion: op.edgeConfigVersion,
        servingMode: publication.serving_mode,
        acceleratorStatus: publication.accelerator_status,
        activeContentHash: op.targetConfigHash,
        outcome: op.outcome,
        noop: plan.noop,
      },
      requestId,
    );
      },
    });
  });
}
