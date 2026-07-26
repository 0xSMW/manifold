export type ScopeType = "workspace" | "team" | "app" | "cost_center" | "key";
export type Budget = {
  id: string; scope: { type: ScopeType; id: string | null }; parentId: string | null;
  unit: "cost_microusd" | "tokens"; currency: string; window: string; limitAmount: string;
  enforcement: "advisory" | "hard"; pricingCatalogRevisionId: string | null;
  counters: { committed: string; reserved: string; current: string }; overBudget: boolean;
  status: string; publishRequired: boolean; burn: Forecast; createdAt: string; updatedAt: string;
};
export type Forecast = { model: string; status: "available" | "unavailable"; currentAmount: string; forecastAmount: string | null; limitAmount?: string; windowStart?: string; windowEnd?: string; burnRatePerDay?: string; reason?: string };
export type BudgetDetailResponse = Budget & { allocations: Allocation[]; reservations: Reservation[]; alerts: Alert[] };
export type Allocation = { id: string; parentId: string; childId: string; childScope: { type: ScopeType; id: string | null }; reservedAllowance: string; window: string; createdAt: string };
export type Reservation = { id: string; requestId: string; estimatedInputTokens: string; maxOutputTokens: string; reservedMicrousd: string; reservedTokens: string | null; status: string; reconciledMicrousd: string | null; reconciledTokens: string | null; expiresAt: string; createdAt: string; reconciledAt: string | null };
export type Alert = { id: string; scope: { type: string; id: string | null }; metric: string; threshold: string; window: string; destinations: unknown; status: string; createdAt: string };
export type Page<T> = { data: T[]; nextCursor: string | null };
export type Context = { apps: Array<{ id: string; name: string; slug: string }>; teams: Array<{ id: string; name: string; slug: string }>; costCenters: Array<{ id: string; name: string; slug: string }>; };
export type Key = { id: string; displayPrefix: string };
