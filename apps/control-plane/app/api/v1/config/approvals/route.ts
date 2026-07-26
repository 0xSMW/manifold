import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { requireInstallation } from "@/lib/db";
import { genId } from "@/lib/ids";
import { buildSignedPlan } from "@/lib/snapshot";
import { runMutationGuard } from "@/lib/mutation-guard";
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

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:write");
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      // A fresh persisted approval is intentionally bounded independently of apply.
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async (sql) => {
    if (
      principal.actorKind !== "member" ||
      !principal.member ||
      !["owner", "admin"].includes(principal.member.role)
    ) {
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "tripwire approval requires an admin or owner browser session",
        reasonCodes: [],
        remediation: "sign in as a workspace admin or owner",
      });
    }

    const body = await contractBody(req, ConfigContracts.approval);
    const installationId = body.installationId;
    const expectedPlanHash = body.planHash;
    // Stay inside the guard's scoped transaction. Opening a second workspace transaction here
    // deadlocks deployments configured with one pooled connection.
    await requireInstallation(principal.workspaceId, installationId, sql);
    const current = await buildSignedPlan(principal.workspaceId, installationId, sql);
    if (current.planHash !== expectedPlanHash) {
      throw new ManifoldError({
        status: 409,
        code: "CONFIG_PRECONDITION_FAILED",
        message: "the plan changed before approval",
        reasonCodes: ["CONFIG_PRECONDITION_FAILED"],
        remediation: "review and approve the current plan",
        retryable: true,
      });
    }
    if (current.tripwireItems.length === 0) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "the current plan has no destructive items",
        reasonCodes: [],
      });
    }

    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const approvals = await (async () => {
      const rows: Array<{ id: string; kind: string; ref: string }> = [];
      for (const item of current.tripwireItems) {
        const id = genId("cfgapr");
        await sql`
          INSERT INTO config_tripwire_approval
            (id, workspace_id, installation_id, plan_hash, kind, ref, approved_by, expires_at)
          VALUES
            (${id}, ${principal.workspaceId}, ${installationId}, ${current.planHash},
             ${item.kind}, ${item.ref}, ${principal.member!.id}, ${expiresAt})`;
        rows.push({ id, kind: item.kind, ref: item.ref });
      }
      await audit(sql, principal, {
        action: "config.approve",
        targetKind: "gateway_installation",
        targetId: installationId,
        requestId,
        detail: {
          planHash: current.planHash,
          items: current.tripwireItems,
          expiresAt: expiresAt.toISOString(),
        },
      });
      return rows;
    })();

    return contractOk(ConfigContracts.approvalResponse,
      {
        installationId,
        planHash: current.planHash,
        approvals,
        expiresAt: expiresAt.toISOString(),
      },
      requestId,
      201,
    );
      },
    });
  });
}
