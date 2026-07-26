import { audit } from "@/lib/audit";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { runMutationGuard } from "@/lib/mutation-guard";
import { authorizeSettings } from "@/lib/settings/access";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) { return wrapInEnvelope(async (requestId) => { contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery); const principal = await authorizeSettings(req, "config:write"); const { id } = await ctx.params; return runMutationGuard({ request: req, principal, requestId, handler: async (sql) => { const row = (await sql<{ id: string; revoked_at: string | null }[]>`SELECT id, revoked_at FROM api_token WHERE id = ${id} AND workspace_id = ${principal.workspaceId} LIMIT 1`)[0]; if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "API token not found", reasonCodes: [] }); if (!row.revoked_at) { await sql`UPDATE api_token SET revoked_at = now() WHERE id = ${id} AND workspace_id = ${principal.workspaceId}`; await audit(sql, principal, { action: "api_token.revoke", targetKind: "api_token", targetId: id, requestId }); } return contractOk(SettingsEndpointContracts.tokenRevoke, { data: { id, revoked: true } }, requestId); } }); }); }
