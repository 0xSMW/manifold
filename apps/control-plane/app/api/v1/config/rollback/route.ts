import { rollback, type ConfigSnapshot } from "@manifold/config";
import { authorize, type Principal } from "@/lib/auth";
import { db, requireInstallation, withWorkspace } from "@/lib/db";
import { mutationOperationKey, runPostCommitMutationGuard } from "@/lib/mutation-guard";
import { reconcileConfigOperation, snapshotStore } from "@/lib/snapshot";
import { contractBody, contractOk } from "@/lib/contracts";
import { ConfigContracts } from "@manifold/contracts";
import {
  jsonBody,
  ManifoldError,
  ok,
  requireString,
  wrapInEnvelope,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// authorize() has already clamped bearer scopes before this route runs. A personal token with
// config:write is therefore an explicitly delegated human action; service and legacy tokens do
// not get rollback authority. Browser sessions retain the stricter admin/owner check.
export function mayRollbackConfig(principal: Pick<Principal, "actorKind" | "member" | "tokenKind">): boolean {
  if (principal.actorKind === "api_token") return principal.tokenKind === "personal";
  return !!principal.member && ["owner", "admin"].includes(principal.member.role);
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:write");
    return runPostCommitMutationGuard({
      request: req,
      principal,
      requestId,
      // Rollback changes the active revision and republishes stored snapshot bytes.
      rateLimit: { limit: 5, windowMs: 60_000 },
      handler: async () => {
    if (!mayRollbackConfig(principal)) {
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "config rollback requires an admin or owner browser session or a personal token with config:write",
        reasonCodes: [],
        remediation: "sign in as a workspace admin or owner, or use a personal token with config:write",
      });
    }
    const { installationId, revisionId, baseConfigHash } = await contractBody(req, ConfigContracts.rollback);
    await requireInstallation(principal.workspaceId, installationId);

    const targets = await withWorkspace(principal.workspaceId, (sql) =>
      sql<{ snapshot: ConfigSnapshot }[]>`
        SELECT snapshot FROM gateway_config_revision
        WHERE id = ${revisionId}
          AND installation_id = ${installationId}
          AND workspace_id = ${principal.workspaceId}
        LIMIT 1`,
    );
    const target = targets[0];
    if (!target) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "config revision not found",
        reasonCodes: [],
      });
    }
    const publishStore = snapshotStore(target.snapshot);
    const op = await rollback(db().$client, revisionId, publishStore, {
      workspaceId: principal.workspaceId,
      expectedBaseConfigHash: baseConfigHash,
      actorKind: principal.actorKind,
      actorId: principal.actorId,
      memberId: principal.actorKind === "member" ? principal.member?.id : undefined,
      requestId,
      mutationKey: mutationOperationKey(req, principal),
    });
    // The revision/job transaction above has committed.  Publish eagerly, while keeping the
    // durable reconciliation job as the recovery authority if this bounded attempt fails.
    if (op.outcome === "accepted" && op.revisionId && publishStore) {
      try { await reconcileConfigOperation(principal.workspaceId, op.id); } catch { /* retained for recovery */ }
    }
    if (op.outcome === "rejected") {
      throw new ManifoldError({
        status: 409,
        code: "CONFIG_PRECONDITION_FAILED",
        message: "active revision advanced during rollback",
        reasonCodes: ["CONFIG_PRECONDITION_FAILED"],
        remediation: "refresh config history and retry against the current active hash",
        retryable: true,
      });
    }
    const [publication] = await withWorkspace(principal.workspaceId, (sql) =>
      sql<{ serving_mode: "boot_fallback" | "edge_config"; accelerator_status: "not_configured" | "pending" | "published" | "reconciliation_required" | "superseded"; edge_config_version: string | null }[]>`
        SELECT serving_mode, accelerator_status, edge_config_version FROM config_operation
        WHERE id = ${op.id} AND workspace_id = ${principal.workspaceId}`);
    return contractOk(ConfigContracts.rollbackResponse,
      {
        operationId: op.id,
        revisionId: op.revisionId,
        activeContentHash: op.targetConfigHash,
        servingMode: publication?.serving_mode ?? "boot_fallback",
        acceleratorStatus: publication?.accelerator_status ?? "not_configured",
        edgeConfigVersion: publication?.edge_config_version ?? op.edgeConfigVersion,
        byteIdentical: true,
      },
      requestId,
    );
      },
    });
  });
}
