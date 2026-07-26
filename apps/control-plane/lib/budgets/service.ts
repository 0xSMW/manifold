import { ManifoldError } from "@/lib/http";
import type { Sql } from "@/lib/db";

export const SCOPE_TYPES = new Set(["workspace", "team", "app", "cost_center", "key"]);
export const UNITS = new Set(["cost_microusd", "tokens"]);
export const WINDOWS = new Set(["daily", "weekly", "monthly", "rolling_30d", "total"]);
export const ENFORCEMENTS = new Set(["advisory", "hard"]);

export type BudgetInput = {
  scopeType: string;
  scopeId: string | null;
  parentId: string | null;
  unit: string;
  currency: "USD";
  window: string;
  limitAmount: string;
  enforcement: string;
  pricingCatalogRevisionId: string | null;
};

function invalid(path: string, message: string): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message,
    reasonCodes: [],
    details: { issues: [{ path, message }] },
  });
}

function optionalId(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, `${field} must be a non-empty string or null`);
  return value.trim();
}

function integerAmount(body: Record<string, unknown>): string {
  const value = body.limitAmount;
  if (typeof value !== "string" && typeof value !== "number") invalid("limitAmount", "limitAmount must be a non-negative safe integer represented as a string or number");
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) invalid("limitAmount", "limitAmount must be a non-negative integer");
  try {
    if (BigInt(normalized) > 9_223_372_036_854_775_807n) invalid("limitAmount", "limitAmount exceeds bigint range");
  } catch {
    invalid("limitAmount", "limitAmount must be a non-negative integer");
  }
  return normalized;
}

/** Strict POST /budgets input. workspaceId and any activation/publish assertion are deliberately absent. */
export function parseBudgetInput(body: Record<string, unknown>): BudgetInput {
  const allowed = new Set(["scopeType", "scopeId", "parentId", "unit", "currency", "window", "limitAmount", "enforcement", "pricingCatalogRevisionId"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid(key, `unknown field '${key}'`);
  const scopeType = body.scopeType;
  const unit = body.unit;
  const window = body.window;
  const enforcement = body.enforcement;
  if (typeof scopeType !== "string" || !SCOPE_TYPES.has(scopeType)) invalid("scopeType", "scopeType must be workspace, team, app, cost_center, or key");
  if (typeof unit !== "string" || !UNITS.has(unit)) invalid("unit", "unit must be cost_microusd or tokens");
  if (typeof window !== "string" || !WINDOWS.has(window)) invalid("window", "window must be daily, weekly, monthly, rolling_30d, or total");
  if (typeof enforcement !== "string" || !ENFORCEMENTS.has(enforcement)) invalid("enforcement", "enforcement must be advisory or hard");
  const scopeId = optionalId(body, "scopeId");
  if ((scopeType === "workspace") !== (scopeId === null)) invalid("scopeId", "workspace budgets require scopeId null; other scopes require scopeId");
  const currency = body.currency ?? "USD";
  if (currency !== "USD") invalid("currency", "currency must be USD");
  const pricingCatalogRevisionId = optionalId(body, "pricingCatalogRevisionId");
  if (enforcement === "hard" && !pricingCatalogRevisionId) invalid("pricingCatalogRevisionId", "hard budgets require a pricingCatalogRevisionId");
  if (enforcement === "advisory" && pricingCatalogRevisionId) invalid("pricingCatalogRevisionId", "pricingCatalogRevisionId is only accepted for hard budgets");
  return { scopeType, scopeId, parentId: optionalId(body, "parentId"), unit, currency, window, limitAmount: integerAmount(body), enforcement, pricingCatalogRevisionId };
}

/**
 * The schema has no explicit approval field. `operator_override` is the only schema-level,
 * operator-authored fidelity state, so it is accepted alongside provider_verified. Aggregator
 * and unknown prices always fail closed. We can prove catalog completeness, not route reachability:
 * budgets have no installation/profile/route relation in the current schema.
 */
export async function requireVerifiedCatalog(sql: Sql, catalogRevisionId: string): Promise<void> {
  const rows = await sql<{ offerings: string; unacceptable: string }[]>`
    SELECT COUNT(o.id)::text AS offerings,
           COUNT(o.id) FILTER (
             WHERE p.id IS NULL
                OR p.catalog_revision IS DISTINCT FROM ${catalogRevisionId}
                OR p.fidelity NOT IN ('provider_verified', 'operator_override')
           )::text AS unacceptable
    FROM provider_model_offering o
    LEFT JOIN provider_price_revision p ON p.id = o.active_price_revision_id
    WHERE o.catalog_revision = ${catalogRevisionId}`;
  const row = rows[0];
  if (!row || BigInt(row.offerings) === 0n || BigInt(row.unacceptable) !== 0n) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "hard budget requires a non-empty catalog whose active prices are provider_verified or operator_override",
      reasonCodes: ["BUDGET_PRICE_UNKNOWN"],
      remediation: "select a complete verified catalog revision or use advisory enforcement",
    });
  }
}

export function page(req: Request) {
  const url = new URL(req.url);
  const raw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 100) : 50;
  return {
    limit,
    cursor: url.searchParams.get("cursor"),
    scopeType: url.searchParams.get("scopeType"),
    enforcement: url.searchParams.get("enforcement"),
    overBudget: url.searchParams.get("overBudget"),
  };
}

export const CURRENT_WINDOW_SQL = `
  (b.window = 'total'
   OR (b.window = 'daily' AND s.window_start >= date_trunc('day', now()))
   OR (b.window = 'weekly' AND s.window_start >= date_trunc('week', now()))
   OR (b.window = 'monthly' AND s.window_start >= date_trunc('month', now()))
   OR (b.window = 'rolling_30d' AND s.window_start >= date_trunc('day', now()) - interval '29 days'))
`;

export function forecast(currentAmount: string, limitAmount: string, window: string, now = new Date()) {
  if (window === "total") return { model: "linear_window_run_rate", status: "unavailable", currentAmount, forecastAmount: null, reason: "total budgets have no end boundary" };
  const start = new Date(now);
  let end: Date;
  if (window === "daily") { start.setUTCHours(0, 0, 0, 0); end = new Date(start); end.setUTCDate(end.getUTCDate() + 1); }
  else if (window === "weekly") { start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); end = new Date(start); end.setUTCDate(end.getUTCDate() + 7); }
  else if (window === "monthly") { start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0); end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); }
  else { start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - 29); end = new Date(start.getTime() + 30 * 86_400_000); }
  const elapsed = Math.max(now.getTime() - start.getTime(), 1);
  const duration = end.getTime() - start.getTime();
  const projected = (BigInt(currentAmount) * BigInt(Math.round(duration))) / BigInt(Math.round(elapsed));
  return { model: "linear_window_run_rate", status: "available", currentAmount, forecastAmount: projected.toString(), limitAmount, windowStart: start.toISOString(), windowEnd: end.toISOString(), burnRatePerDay: ((BigInt(currentAmount) * 86_400_000n) / BigInt(Math.round(elapsed))).toString() };
}
