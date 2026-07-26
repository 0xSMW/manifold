import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { genId } from "@/lib/ids";
import { ManifoldError, jsonBody, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { BudgetEndpointContracts } from "@manifold/contracts";
import {
  CURRENT_WINDOW_SQL,
  forecast,
  page,
  parseBudgetInput,
  requireVerifiedCatalog,
} from "@/lib/budgets/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  scope_type: string;
  scope_id: string | null;
  parent_id: string | null;
  unit: string;
  currency: string;
  window: string;
  limit_amount: string;
  enforcement: string;
  pricing_catalog_revision_id: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  committed: string;
  reserved: string;
};

function view(row: Row) {
  const currentAmount = (
    BigInt(row.committed) + BigInt(row.reserved)
  ).toString();
  const limitAmount = row.limit_amount;
  return {
    id: row.id,
    scope: { type: row.scope_type, id: row.scope_id },
    parentId: row.parent_id,
    unit: row.unit,
    currency: row.currency,
    window: row.window,
    limitAmount,
    enforcement: row.enforcement,
    pricingCatalogRevisionId: row.pricing_catalog_revision_id,
    counters: {
      committed: row.committed,
      reserved: row.reserved,
      current: currentAmount,
    },
    overBudget: BigInt(currentAmount) > BigInt(limitAmount),
    status: row.disabled_at ? "disabled" : "staged",
    publishRequired: !row.disabled_at,
    burn: forecast(currentAmount, limitAmount, row.window),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "budgets:read");
    const { limit, cursor, scopeType, enforcement, overBudget } = page(req);
    if (
      scopeType &&
      !["workspace", "team", "app", "cost_center", "key"].includes(scopeType)
    )
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "scopeType is invalid",
        reasonCodes: [],
      });
    if (enforcement && !["advisory", "hard"].includes(enforcement))
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "enforcement is invalid",
        reasonCodes: [],
      });
    if (overBudget && overBudget !== "true" && overBudget !== "false")
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "overBudget must be true or false",
        reasonCodes: [],
      });
    const rows = await withWorkspace(
      principal.workspaceId,
      (sql) => sql<Row[]>`
      SELECT b.id, b.scope_type, b.scope_id, b.parent_id, b.unit, b.currency, b.window,
             b.limit_amount::text, b.enforcement, b.pricing_catalog_revision_id, b.disabled_at,
             b.created_at, b.updated_at,
             COALESCE(SUM(CASE WHEN b.unit = 'cost_microusd' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_microusd WHEN b.unit = 'tokens' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_tokens ELSE 0 END), 0)::text AS committed,
             COALESCE(SUM(CASE WHEN b.unit = 'cost_microusd' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.reserved_microusd WHEN b.unit = 'tokens' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.reserved_tokens ELSE 0 END), 0)::text AS reserved
      FROM budget_account b
      LEFT JOIN budget_window_state s ON s.budget_account_id = b.id AND s.workspace_id = ${principal.workspaceId}
      WHERE b.workspace_id = ${principal.workspaceId} AND b.disabled_at IS NULL
        AND (${cursor}::text IS NULL OR b.id < ${cursor})
        AND (${scopeType}::text IS NULL OR b.scope_type = ${scopeType})
        AND (${enforcement}::text IS NULL OR b.enforcement = ${enforcement})
      GROUP BY b.id
      HAVING (${overBudget}::text IS NULL OR (COALESCE(SUM(CASE WHEN b.unit = 'cost_microusd' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_microusd + s.reserved_microusd WHEN b.unit = 'tokens' AND ${sql.unsafe(CURRENT_WINDOW_SQL)} THEN s.committed_tokens + s.reserved_tokens ELSE 0 END), 0) > b.limit_amount) = (${overBudget} = 'true'))
      ORDER BY b.id DESC LIMIT ${limit + 1}`,
    );
    const data = rows
      .slice(0, limit)
      .filter((row): row is Row => row !== undefined)
      .map(view);
    return contractOk(BudgetEndpointContracts.list,
      {
        data,
        nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null,
      },
      requestId,
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "budgets:write");
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      handler: async (sql) => {
        const input = parseBudgetInput(await contractBody(req, BudgetEndpointContracts.create));
        const result = await (async () => {
          if (input.enforcement === "hard")
            await requireVerifiedCatalog(sql, input.pricingCatalogRevisionId!);
          if (input.scopeId) {
            const tables: Record<string, string> = {
              team: "team",
              app: "app",
              cost_center: "cost_center",
              key: "virtual_key",
            };
            const table = tables[input.scopeType];
            if (
              table &&
              !(
                await sql<
                  { id: string }[]
                >`SELECT id FROM ${sql(table)} WHERE id = ${input.scopeId} AND workspace_id = ${principal.workspaceId} LIMIT 1`
              )[0]
            )
              return { error: "scope" as const };
          }
          if (input.parentId) {
            const parent = (
              await sql<
                { id: string; unit: string; window: string }[]
              >`SELECT id, unit, window FROM budget_account WHERE id = ${input.parentId} AND workspace_id = ${principal.workspaceId} AND disabled_at IS NULL LIMIT 1`
            )[0];
            if (!parent) return { error: "parent" as const };
            if (parent.unit !== input.unit || parent.window !== input.window)
              return { error: "parentMismatch" as const };
          }
          const existing = (
            await sql<
              Row[]
            >`SELECT b.id, b.scope_type, b.scope_id, b.parent_id, b.unit, b.currency, b.window, b.limit_amount::text, b.enforcement, b.pricing_catalog_revision_id, b.disabled_at, b.created_at, b.updated_at, '0'::text AS committed, '0'::text AS reserved FROM budget_account b WHERE b.workspace_id = ${principal.workspaceId} AND b.scope_type = ${input.scopeType} AND b.scope_id IS NOT DISTINCT FROM ${input.scopeId} AND b.window = ${input.window} LIMIT 1`
          )[0];
          if (existing) return { existing };
          const id = genId("bud");
          await sql`INSERT INTO budget_account (id, workspace_id, scope_type, scope_id, parent_id, unit, currency, window, limit_amount, enforcement, pricing_catalog_revision_id) VALUES (${id}, ${principal.workspaceId}, ${input.scopeType}, ${input.scopeId}, ${input.parentId}, ${input.unit}, ${input.currency}, ${input.window}, ${input.limitAmount}, ${input.enforcement}, ${input.pricingCatalogRevisionId})`;
          await audit(sql, principal, {
            action: "budget.create",
            targetKind: "budget_account",
            targetId: id,
            requestId,
            detail: {
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              unit: input.unit,
              window: input.window,
              enforcement: input.enforcement,
              staged: true,
            },
          });
          return { id };
        })();
        if ("error" in result)
          throw new ManifoldError({
            status:
              result.error === "scope" || result.error === "parent" ? 404 : 422,
            code:
              result.error === "parentMismatch" ? "VALIDATION" : "NOT_FOUND",
            message:
              result.error === "parentMismatch"
                ? "parent budget must use the same unit and window"
                : `${result.error} not found`,
            reasonCodes: [],
          });
        if ("existing" in result && result.existing)
          return contractOk(BudgetEndpointContracts.created, { ...view(result.existing), created: false }, requestId);
        return contractOk(BudgetEndpointContracts.created,
          {
            id: result.id,
            status: "staged",
            publishRequired: true,
            activeEnforcement: false,
          },
          requestId,
          201,
        );
      },
    });
  });
}
