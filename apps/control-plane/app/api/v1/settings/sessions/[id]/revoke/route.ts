import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeAccountSession } from "@/lib/account-access";
import { audit } from "@/lib/audit";
import { runMutationGuard } from "@/lib/mutation-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorizeAccountSession(req);
    const { id } = await ctx.params;
    return runMutationGuard({ request: req, principal, requestId, handler: async (sql) => {
      contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery);
      const row = (await sql<{ revoked_at: string }[]>`UPDATE console_session SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id} AND workspace_id=${principal.workspaceId} AND member_id=${principal.member!.id} RETURNING revoked_at`)[0];
      if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "session not found", reasonCodes: [] });
      await audit(sql, principal, { action: "session.revoke", targetKind: "console_session", targetId: id, requestId });
      return contractOk(SettingsEndpointContracts.sessionRevoke, { data: { id, status: "revoked", revoked: true, revokedAt: row.revoked_at } }, requestId);
    } });
  });
}
