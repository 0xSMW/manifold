import { wrapInEnvelope } from "@/lib/http";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeAccountSession } from "@/lib/account-access";
import { audit } from "@/lib/audit";
import { runMutationGuard } from "@/lib/mutation-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorizeAccountSession(req);
    return runMutationGuard({ request: req, principal, requestId, handler: async (sql) => {
      contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery);
      const rows = await sql<{ id: string }[]>`UPDATE console_session SET revoked_at=now() WHERE workspace_id=${principal.workspaceId} AND member_id=${principal.member!.id} AND revoked_at IS NULL AND (${principal.sessionId ?? null}::text IS NULL OR id<>${principal.sessionId ?? null}) RETURNING id`;
      await audit(sql, principal, { action: "session.revoke_others", targetKind: "member", targetId: principal.member!.id, requestId, detail: { count: rows.length } });
      return contractOk(SettingsEndpointContracts.sessionRevokeOthers, { data: { revokedCount: rows.length } }, requestId);
    } });
  });
}
