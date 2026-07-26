import { audit } from "@/lib/audit";
import { wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { genId } from "@/lib/ids";
import { runMutationGuard } from "@/lib/mutation-guard";
import { authorizeSettings } from "@/lib/settings/access";
import { notFound } from "@/lib/settings/crud";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) { return wrapInEnvelope(async (requestId) => { contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery); const principal = await authorizeSettings(req, "config:write"); const { id: appId } = await ctx.params; return runMutationGuard({ request: req, principal, requestId, handler: async (sql) => { const value = await contractBody(req, SettingsEndpointContracts.action); if (!(await sql<{ id: string }[]>`SELECT id FROM app WHERE id = ${appId} AND workspace_id = ${principal.workspaceId} AND archived_at IS NULL`)[0]) throw notFound("app"); const id = genId("act"); const row = (await sql<{ id: string; slug: string; name: string | null; source: string }[]>`INSERT INTO action (id, workspace_id, app_id, slug, name, source) VALUES (${id}, ${principal.workspaceId}, ${appId}, ${value.slug}, ${value.name ?? null}, 'explicit') RETURNING id, slug, name, source`)[0]!; await audit(sql, principal, { action: "action.create", targetKind: "action", targetId: id, requestId, detail: { appId, ...value } }); return contractOk(SettingsEndpointContracts.actionResponse, { data: row }, requestId, 201); } }); }); }
