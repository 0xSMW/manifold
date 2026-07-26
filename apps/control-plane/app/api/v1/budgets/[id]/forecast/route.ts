import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { CURRENT_WINDOW_SQL, forecast } from "@/lib/budgets/service";
import { contractOk } from "@/lib/contracts";
import { BudgetEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "budgets:read");
    const { id } = await context.params;
    const row = await withWorkspace(principal.workspaceId, async (sql) => (await sql<{ unit: string; window: string; limit_amount: string; committed: string; reserved: string }[]>`
      SELECT b.unit, b.window, b.limit_amount::text,
             COALESCE(SUM(CASE WHEN b.unit = 'cost_microusd' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_microusd WHEN b.unit = 'tokens' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_tokens ELSE 0 END), 0)::text AS committed,
             COALESCE(SUM(CASE WHEN b.unit = 'cost_microusd' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.reserved_microusd WHEN b.unit = 'tokens' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.reserved_tokens ELSE 0 END), 0)::text AS reserved
      FROM budget_account b LEFT JOIN budget_window_state s ON s.budget_account_id = b.id AND s.workspace_id = ${principal.workspaceId}
      WHERE b.id = ${id} AND b.workspace_id = ${principal.workspaceId} GROUP BY b.id`)[0]);
    if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "budget not found", reasonCodes: [] });
    const currentAmount = (BigInt(row.committed) + BigInt(row.reserved)).toString();
    return contractOk(BudgetEndpointContracts.forecast, { budgetId: id, unit: row.unit, counters: { committed: row.committed, reserved: row.reserved, current: currentAmount }, ...forecast(currentAmount, row.limit_amount, row.window) }, requestId);
  });
}
