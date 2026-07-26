import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk, contractOptionalEmptyBody } from "@/lib/contracts";
import { ProvidersApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "providers:write");
    const { id } = await ctx.params;
    await contractOptionalEmptyBody(req.clone(), ProvidersApi.emptyRequest);
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 10, windowMs: 60_000 }, handler: async (sql) => {
    const revoked = await (async () => {
      const rows = await sql<{ id: string }[]>`
        UPDATE provider_credential
        SET revoked_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
          AND revoked_at IS NULL
        RETURNING id`;
      if (rows[0]) {
        await audit(sql, principal, {
          action: "provider.revoke",
          targetKind: "provider_credential",
          targetId: id,
          requestId,
        });
        return rows[0];
      }
      const existing = await sql<{ id: string }[]>`
        SELECT id FROM provider_credential
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
        LIMIT 1`;
      return existing[0] ?? null;
    })();
    if (!revoked) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "provider credential not found",
        reasonCodes: [],
      });
    }

    return contractOk(ProvidersApi.revokeResponse, { id: revoked.id, revoked: true }, requestId);
    }});
  });
}
