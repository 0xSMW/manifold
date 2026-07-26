import { audit } from "@/lib/audit";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { runMutationGuard } from "@/lib/mutation-guard";
import { authorizeSettings, strictBody } from "@/lib/settings/access";
import { scopesBoundedByRole } from "@/lib/settings/cli-authorization";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => {
  contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery); const principal = await authorizeSettings(req, "cli:approve"); const body = await contractBody(req, SettingsEndpointContracts.cliDecision); strictBody(body, ["userCode"]);
  const userCode = body.userCode;
  if (typeof userCode !== "string" || !/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(userCode)) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "userCode must be the displayed authorization code", reasonCodes: [] });
  return runMutationGuard({ request: req, principal, requestId, handler: async (sql) => {
    const rows = await sql<{ id: string; scopes: unknown; status: string; expires_at: string }[]>`SELECT id, scopes, status, expires_at FROM cli_authorization WHERE workspace_id = ${principal.workspaceId} AND user_code = ${userCode} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "device authorization was not found", reasonCodes: ["USER_CODE_INVALID"] });
    if (new Date(row.expires_at).getTime() <= Date.now()) { await sql`UPDATE cli_authorization SET status = 'expired' WHERE id = ${row.id} AND workspace_id = ${principal.workspaceId} AND status = 'pending'`; throw new ManifoldError({ status: 410, code: "NOT_FOUND", message: "device authorization has expired", reasonCodes: ["CLI_AUTH_EXPIRED"] }); }
    if (row.status !== "pending") throw new ManifoldError({ status: 409, code: "IDEMPOTENCY_CONFLICT", message: `device authorization is already ${row.status}`, reasonCodes: ["CLI_AUTH_NOT_PENDING"] });
    const scopes = scopesBoundedByRole(row.scopes, principal.member!.role);
    await sql`UPDATE cli_authorization SET status = 'approved', approved_by = ${principal.member!.id}, approved_at = now(), poll_not_before = now() WHERE id = ${row.id} AND workspace_id = ${principal.workspaceId} AND status = 'pending'`;
    await audit(sql, principal, { action: "cli.authorize", targetKind: "cli_authorization", targetId: row.id, requestId, detail: { scopes } });
    return contractOk(SettingsEndpointContracts.cliApproved, { data: { id: row.id, status: "approved", scopes } }, requestId);
  }});
}); }
