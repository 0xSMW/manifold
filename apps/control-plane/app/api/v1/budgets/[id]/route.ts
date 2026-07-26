import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { CURRENT_WINDOW_SQL, forecast } from "@/lib/budgets/service";
import { contractOk } from "@/lib/contracts";
import { BudgetEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Account = { id: string; scope_type: string; scope_id: string | null; parent_id: string | null; unit: string; currency: string; window: string; limit_amount: string; enforcement: string; pricing_catalog_revision_id: string | null; disabled_at: string | null; created_at: string; updated_at: string; committed: string; reserved: string };
type Allocation = { id: string; parent_id: string; child_id: string; reserved_allowance: string; window: string; created_at: string; child_scope_type: string; child_scope_id: string | null };
type Reservation = { id: string; request_id: string; estimated_input_tokens: string; max_output_tokens: string; reserved_microusd: string; reserved_tokens: string | null; status: string; reconciled_microusd: string | null; reconciled_tokens: string | null; expires_at: string; created_at: string; reconciled_at: string | null };
type Alert = { id: string; scope_type: string; scope_id: string | null; metric: string; threshold: string; window: string; destinations: unknown; disabled_at: string | null; created_at: string };

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "budgets:read");
    const { id } = await context.params;
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const account = (await sql<Account[]>`
        SELECT b.id, b.scope_type, b.scope_id, b.parent_id, b.unit, b.currency, b.window,
               b.limit_amount::text, b.enforcement, b.pricing_catalog_revision_id, b.disabled_at,
               b.created_at, b.updated_at,
               COALESCE(SUM(CASE WHEN b.unit = 'cost_microusd' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_microusd WHEN b.unit = 'tokens' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_tokens ELSE 0 END), 0)::text AS committed,
               COALESCE(SUM(CASE WHEN b.unit = 'cost_microusd' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.reserved_microusd WHEN b.unit = 'tokens' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.reserved_tokens ELSE 0 END), 0)::text AS reserved
        FROM budget_account b
        LEFT JOIN budget_window_state s ON s.budget_account_id = b.id AND s.workspace_id = ${principal.workspaceId}
        WHERE b.id = ${id} AND b.workspace_id = ${principal.workspaceId}
        GROUP BY b.id`)[0];
      if (!account) return null;
      const [allocations, reservations, alerts] = await Promise.all([
        sql<Allocation[]>`SELECT a.id, a.parent_id, a.child_id, a.reserved_allowance::text, a.window, a.created_at, child.scope_type AS child_scope_type, child.scope_id AS child_scope_id FROM budget_allocation a JOIN budget_account child ON child.id = a.child_id AND child.workspace_id = ${principal.workspaceId} WHERE a.workspace_id = ${principal.workspaceId} AND a.parent_id = ${id} ORDER BY a.created_at DESC`,
        sql<Reservation[]>`SELECT id, request_id, estimated_input_tokens::text, max_output_tokens::text, reserved_microusd::text, reserved_tokens::text, status, reconciled_microusd::text, reconciled_tokens::text, expires_at, created_at, reconciled_at FROM budget_reservation WHERE workspace_id = ${principal.workspaceId} AND budget_account_id = ${id} ORDER BY created_at DESC LIMIT 100`,
        // AlertRule has no budget_account_id. The supported association is the account's own
        // scope + window; do not invent a private "budget_account" scope vocabulary here.
        sql<Alert[]>`SELECT id, scope_type, scope_id, metric, threshold::text, window, destinations, disabled_at, created_at FROM alert_rule WHERE workspace_id = ${principal.workspaceId} AND scope_type = ${account.scope_type} AND scope_id IS NOT DISTINCT FROM ${account.scope_id} AND window = ${account.window} ORDER BY created_at DESC`,
      ]);
      return { account, allocations, reservations, alerts };
    });
    if (!result) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "budget not found", reasonCodes: [] });
    const currentAmount = (BigInt(result.account.committed) + BigInt(result.account.reserved)).toString();
    return contractOk(BudgetEndpointContracts.detail, {
      id: result.account.id,
      scope: { type: result.account.scope_type, id: result.account.scope_id }, parentId: result.account.parent_id,
      unit: result.account.unit, currency: result.account.currency, window: result.account.window,
      limitAmount: result.account.limit_amount, enforcement: result.account.enforcement,
      pricingCatalogRevisionId: result.account.pricing_catalog_revision_id,
      counters: { committed: result.account.committed, reserved: result.account.reserved, current: currentAmount },
      overBudget: BigInt(currentAmount) > BigInt(result.account.limit_amount),
      status: result.account.disabled_at ? "disabled" : "staged", publishRequired: !result.account.disabled_at,
      burn: forecast(currentAmount, result.account.limit_amount, result.account.window),
      allocations: result.allocations.map((x) => ({ id: x.id, parentId: x.parent_id, childId: x.child_id, childScope: { type: x.child_scope_type, id: x.child_scope_id }, reservedAllowance: x.reserved_allowance, window: x.window, createdAt: x.created_at })),
      reservations: result.reservations.map((x) => ({ id: x.id, requestId: x.request_id, estimatedInputTokens: x.estimated_input_tokens, maxOutputTokens: x.max_output_tokens, reservedMicrousd: x.reserved_microusd, reservedTokens: x.reserved_tokens, status: x.status, reconciledMicrousd: x.reconciled_microusd, reconciledTokens: x.reconciled_tokens, expiresAt: x.expires_at, createdAt: x.created_at, reconciledAt: x.reconciled_at })),
      alerts: result.alerts.map((x) => ({ id: x.id, scope: { type: x.scope_type, id: x.scope_id }, metric: x.metric, threshold: x.threshold, window: x.window, destinations: x.destinations, status: x.disabled_at ? "disabled" : "active", createdAt: x.created_at })),
      createdAt: result.account.created_at, updatedAt: result.account.updated_at,
    }, requestId);
  });
}
