import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { CostCentersResponse } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
type Row = { id: string; slug: string; name: string; parent_id: string | null; created_at: string };
export async function GET(req: Request): Promise<Response> { return wrapInEnvelope(async (requestId) => { const principal = await authorize(req, "budgets:read"); const u = new URL(req.url); const cursor = u.searchParams.get("cursor"); const raw = Number(u.searchParams.get("limit") ?? "50"); const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 100) : 50; const rows = await withWorkspace(principal.workspaceId, (sql) => sql<Row[]>`SELECT id, slug, name, parent_id, created_at FROM cost_center WHERE workspace_id = ${principal.workspaceId} AND archived_at IS NULL AND (${cursor}::text IS NULL OR id < ${cursor}) ORDER BY id DESC LIMIT ${limit + 1}`); const data = rows.slice(0, limit).map((c) => ({ id: c.id, slug: c.slug, name: c.name, parentId: c.parent_id, createdAt: c.created_at })); return contractOk(CostCentersResponse, { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null }, requestId); }); }
