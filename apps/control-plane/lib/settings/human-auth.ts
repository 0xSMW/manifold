import { ManifoldError } from "@/lib/http";
import type { Principal } from "@/lib/auth";

export const TOKEN_SCOPE_ALLOWLIST = new Set([
  "routes:read", "observations:read", "registry:read", "budgets:read", "audit:read", "system:read",
  "routes:write", "keys:read", "keys:write", "providers:read", "providers:write", "policies:read", "policies:write", "budgets:write", "registry:write", "config:read",
  "policies:approve", "config:write", "storage:read", "storage:write", "deployments:read", "deployments:write", "cli:approve",
]);
const ROLE_SCOPES: Record<string, Set<string>> = {
  owner: TOKEN_SCOPE_ALLOWLIST,
  admin: new Set([...TOKEN_SCOPE_ALLOWLIST].filter((scope) => scope !== "config:write" ? true : true)),
  editor: new Set(["routes:read", "observations:read", "registry:read", "budgets:read", "audit:read", "system:read", "routes:write", "keys:read", "keys:write", "providers:read", "providers:write", "policies:read", "policies:write", "budgets:write", "registry:write", "config:read"]),
  viewer: new Set(["routes:read", "observations:read", "registry:read", "budgets:read", "audit:read", "system:read"]),
  billing: new Set(["budgets:read", "audit:read"]),
};

export function validatedTokenScopes(principal: Principal, scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()))];
  const ceiling = ROLE_SCOPES[principal.member?.role ?? ""];
  if (!ceiling || normalized.some((scope) => scope === "*" || !TOKEN_SCOPE_ALLOWLIST.has(scope) || !ceiling.has(scope))) {
    throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "requested token scopes exceed your role ceiling", reasonCodes: ["SCOPE_CEILING"] });
  }
  return normalized;
}

export function expiry(value: string | null | undefined, defaultDays = 90): string {
  if (value === null) return new Date(Date.now() + defaultDays * 86_400_000).toISOString();
  if (value === undefined) return new Date(Date.now() + defaultDays * 86_400_000).toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed > Date.now() + 365 * 86_400_000) {
    throw new ManifoldError({ status: 422, code: "VALIDATION", message: "expiresAt must be a future timestamp within one year", reasonCodes: [] });
  }
  return new Date(parsed).toISOString();
}

export function memberStatus(row: { disabled_at: string | null; accepted_at?: string | null }): "active" | "disabled" | "pending" {
  return row.disabled_at ? "disabled" : row.accepted_at ? "active" : "pending";
}
