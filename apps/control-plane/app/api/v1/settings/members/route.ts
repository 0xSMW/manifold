import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeSettings } from "@/lib/settings/access";
import { audit } from "@/lib/audit";
import { memberStatus } from "@/lib/settings/human-auth";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
type Row = { id: string; email: string; name: string | null; role: string; disabled_at: string | null; accepted_at: string | null; created_at: string };
export async function GET(req: Request) { return wrapInEnvelope(async (requestId) => { const { cursor, limit } = contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.pageQuery); const principal = await authorizeSettings(req, "config:read"); const rows = await withWorkspace(principal.workspaceId, (sql) => sql<Row[]>`SELECT id, email, name, role, disabled_at, accepted_at, created_at FROM member WHERE workspace_id = ${principal.workspaceId} AND (${cursor}::text IS NULL OR id < ${cursor}) ORDER BY id DESC LIMIT ${limit + 1}`); const data = rows.slice(0, limit).map((row) => ({ id: row.id, email: row.email, name: row.name, role: row.role, status: memberStatus(row), createdAt: row.created_at })); return contractOk(SettingsEndpointContracts.lists.member, { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null }, requestId); }); }
/** Direct member provisioning is retired; use the invitation endpoint so no membership is active before acceptance. */
export async function POST(req: Request) { return wrapInEnvelope(async () => { await authorizeSettings(req, "config:write"); throw new ManifoldError({ status: 410, code: "VALIDATION", message: "direct member provisioning is retired; create an invitation instead", reasonCodes: ["MEMBER_PROVISIONING_DEPRECATED"] }); }); }
