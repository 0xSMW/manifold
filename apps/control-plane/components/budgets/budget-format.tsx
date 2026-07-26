import type { Budget, Context, Key, ScopeType } from "./budget-types";

export function formatNumber(value: string | null | undefined) {
  try { return BigInt(value ?? "0").toLocaleString(); } catch { return "Unavailable"; }
}
export function unitLabel(unit: Budget["unit"]) { return unit === "cost_microusd" ? "micro-USD" : "tokens"; }
export function formatAmount(value: string, unit: Budget["unit"]) { return `${formatNumber(value)} ${unitLabel(unit)}`; }
export function formatDate(value: string | null) { if (!value) return "Unavailable"; const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? "Unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed); }
export function scopeLabel(scope: { type: ScopeType | string; id: string | null }, context: Context | null, keys: Key[] | null) {
  if (scope.type === "workspace") return "Workspace";
  const collections: Record<string, Array<{ id: string; name: string; slug: string }> | undefined> = { team: context?.teams, app: context?.apps, cost_center: context?.costCenters };
  const match = collections[scope.type]?.find((item) => item.id === scope.id);
  if (match) return `${scope.type === "cost_center" ? "Cost center" : scope.type.charAt(0).toUpperCase() + scope.type.slice(1)}: ${match.name}`;
  if (scope.type === "key") return `Key: ${keys?.find((item) => item.id === scope.id)?.displayPrefix ?? scope.id ?? "Unavailable"}`;
  return `${scope.type}: ${scope.id ?? "Unavailable"}`;
}
