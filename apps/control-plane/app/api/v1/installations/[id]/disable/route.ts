import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk, contractOptionalEmptyBody } from "@/lib/contracts";
import { InstallationContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:write");
    requireMutationIdempotencyKey(req);
    await contractOptionalEmptyBody(req.clone(), InstallationContracts.empty);
    const { id } = await ctx.params;
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 15, windowMs: 60_000 }, handler: async (sql) => {
    const result = await (async () => {
      const row = (await sql<{ id: string; disabled_at: string }[]>`
        UPDATE gateway_installation
        SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
        RETURNING id, disabled_at`)[0];
      if (!row) return null;
      await audit(sql, principal, {
        action: "installation.disable",
        targetKind: "gateway_installation",
        targetId: id,
        requestId,
      });
      return row;
    })();
    if (!result) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "installation not found",
        reasonCodes: [],
      });
    }
    return contractOk(InstallationContracts.disableResponse, { id: result.id, status: "disabled", disabledAt: result.disabled_at }, requestId);
    }});
  });
}
