import { timingSafeEqual } from "node:crypto";
import { drainAuditDelivery } from "@/lib/audit-delivery";
import { rawSql } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { InternalContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const presented = req.headers.get("authorization");
  if (!expected || !presented || !presented.startsWith("Bearer ")) return false;
  const a = Buffer.from(presented.slice(7)); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bounded Vercel cron dispatcher. The SECURITY DEFINER function returns IDs only; job work stays RLS-scoped. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if (!authorized(req)) throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing cron secret", reasonCodes: [] });
    const rows = await rawSql()<{ workspace_id: string }[]>`SELECT workspace_id FROM audit_delivery_due_workspaces(25)`;
    const results = await Promise.all(rows.map((row) => drainAuditDelivery(row.workspace_id, 10)));
    return contractOk(InternalContracts.auditDeliveryCronResponse, { workspaces: rows.length, claimed: results.reduce((n, item) => n + item.claimed, 0), delivered: results.reduce((n, item) => n + item.delivered, 0), retried: results.reduce((n, item) => n + item.retried, 0), dead: results.reduce((n, item) => n + item.dead, 0) }, requestId);
  });
}
