import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { ControlPlaneContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:write");
    requireMutationIdempotencyKey(req);
    const { id } = await ctx.params;
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 15, windowMs: 60_000 }, handler: async (sql) => {
    const row = await (async () => {
      const updated = (await sql<{ id: string; disabled_at: string }[]>`
        UPDATE gateway_ingress_profile
        SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
        RETURNING id, disabled_at`)[0];
      if (!updated) return null;
      await audit(sql, principal, {
        action: "profile.disable",
        targetKind: "gateway_ingress_profile",
        targetId: id,
        requestId,
      });
      return updated;
    })();
    if (!row) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "profile not found",
        reasonCodes: [],
      });
    }
    return contractOk(ControlPlaneContracts.profiles.disableResponse, {
      id: row.id,
      status: "disabled",
      disabledAt: row.disabled_at,
      unpublishedChanges: 1,
    }, requestId);
    }});
  });
}
