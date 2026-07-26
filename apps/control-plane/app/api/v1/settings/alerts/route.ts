import { withWorkspace, type Sql } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import { authorizeSettings } from "@/lib/settings/access";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
type Row = { id: string; scope_type: string; scope_id: string | null; metric: string; threshold: string; window: string; destinations: unknown; disabled_at: string | null; created_at: string };
export function listAlertRules(sql: Sql, workspaceId: string, cursor: string | null, limit: number): Promise<Row[]> {
  // `window` is a PostgreSQL keyword, so it must remain quoted anywhere raw SQL references it.
  return sql<Row[]>`SELECT id, scope_type, scope_id, metric, threshold, "window", destinations, disabled_at, created_at FROM alert_rule WHERE workspace_id = ${workspaceId} AND (${cursor}::text IS NULL OR id < ${cursor}) ORDER BY id DESC LIMIT ${limit + 1}`;
}
export async function GET(req: Request) { return wrapInEnvelope(async (requestId) => { const { cursor, limit } = contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.pageQuery); const principal = await authorizeSettings(req, "config:read"); const rows = await withWorkspace(principal.workspaceId, (sql) => listAlertRules(sql, principal.workspaceId, cursor, limit)); const data = rows.slice(0, limit).map((row) => ({ id: row.id, scopeType: row.scope_type, scopeId: row.scope_id, metric: row.metric, threshold: row.threshold, window: row.window, destinations: row.destinations, status: row.disabled_at ? "disabled" : "active", createdAt: row.created_at })); return contractOk(SettingsEndpointContracts.alerts, { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null }, requestId); }); }
