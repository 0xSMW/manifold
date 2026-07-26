import { withWorkspace } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeSettings } from "@/lib/settings/access";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
type Row = { id: string; user_code: string; status: string; scopes: unknown; client_id: string; client_name: string; verification_origin: string; interval_seconds: number; expires_at: string; created_at: string; approved_at: string | null; denied_at: string | null; approved_by: string | null; denied_by: string | null };
/** Authenticated human review queue. Values shown here are server-bound at start, never UI input. */
export async function GET(req: Request) { return wrapInEnvelope(async (requestId) => {
  const { cursor, limit } = contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.pageQuery); const principal = await authorizeSettings(req, "cli:approve");
  const rows = await withWorkspace(principal.workspaceId, (sql) => sql<Row[]>`SELECT id, user_code, status, scopes, client_id, client_name, verification_origin, interval_seconds, expires_at, created_at, approved_at, denied_at, approved_by, denied_by FROM cli_authorization
    WHERE workspace_id = ${principal.workspaceId} AND (${cursor}::text IS NULL OR id < ${cursor}) ORDER BY id DESC LIMIT ${limit + 1}`);
  const data = rows.slice(0, limit).map((row) => ({ id: row.id, userCode: row.user_code, status: row.status, requestedScopes: Array.isArray(row.scopes) ? row.scopes : [], client: { id: row.client_id, name: row.client_name }, verificationOrigin: row.verification_origin, intervalSeconds: row.interval_seconds, expiresAt: row.expires_at, createdAt: row.created_at, approvedAt: row.approved_at, deniedAt: row.denied_at, canReview: row.status === "pending" && new Date(row.expires_at).getTime() > Date.now() }));
  return contractOk(SettingsEndpointContracts.cliList, { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null }, requestId);
}); }
