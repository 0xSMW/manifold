// Bearer api_token authentication + per-endpoint scope checks (SPEC §10.1, §15.3).
//
// The presented token is HMAC'd (§14.3) and looked up by keyed_hash. Since the tenant is not
// known until the token resolves, the lookup is inherently cross-tenant and runs BEFORE any
// `manifold.workspace_id` GUC is set. The app connects as the non-superuser `manifold_app` role,
// which RLS (§6.16) applies to, so a direct SELECT on api_token with the GUC unset returns 0 rows.
// The lookup therefore goes through the SECURITY DEFINER function `auth_lookup_token` (migration
// 0002), the ONE audited carve-out that may read a token row by exact hash bypassing RLS. The
// resolved principal carries workspace_id + scopes; every subsequent query is workspace-scoped.
import { keyedHash } from "@/lib/crypto";
import { rawSql } from "@/lib/db";
import { ManifoldError } from "@/lib/http";

export interface Principal {
  workspaceId: string;
  tokenId: string;
  scopes: string[];
}

interface ApiTokenRow {
  id: string;
  workspace_id: string;
  scopes: unknown;
  revoked_at: string | null;
  expires_at: string | null;
}

function scopesToArray(scopes: unknown): string[] {
  if (Array.isArray(scopes)) return scopes.map(String);
  if (scopes && typeof scopes === "object") return Object.keys(scopes as object);
  return [];
}

function unauthenticated(reason: string, message: string): ManifoldError {
  return new ManifoldError({
    status: 401,
    code: "UNAUTHENTICATED",
    message,
    reasonCodes: [reason],
    remediation: "present a valid `Authorization: Bearer <api_token>` header",
  });
}

/** Resolve the bearer api_token to a Principal, or throw a 401 envelope. */
export async function authenticate(req: Request): Promise<Principal> {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw unauthenticated("AUTH_KEY_UNKNOWN", "missing bearer token");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw unauthenticated("AUTH_KEY_UNKNOWN", "empty bearer token");
  }

  const hash = keyedHash(token);
  const sql = rawSql();
  // Cross-tenant lookup through the RLS carve-out (SECURITY DEFINER, migration 0002). A plain
  // SELECT here would return 0 rows under the non-superuser app role with no workspace GUC set.
  const rows = await sql<ApiTokenRow[]>`
    SELECT id, workspace_id, scopes, revoked_at, expires_at
    FROM auth_lookup_token(${hash})`;
  const row = rows[0];
  if (!row) throw unauthenticated("AUTH_KEY_UNKNOWN", "unknown api token");
  if (row.revoked_at) throw unauthenticated("AUTH_KEY_REVOKED", "api token revoked");
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw unauthenticated("AUTH_KEY_EXPIRED", "api token expired");
  }

  // Best-effort last_used_at touch (fire-and-forget; not part of the request txn). Routed through
  // the definer carve-out too, since a direct UPDATE would match 0 rows under RLS pre-GUC.
  sql`SELECT auth_touch_token(${row.id})`.catch(() => {});

  return {
    workspaceId: row.workspace_id,
    tokenId: row.id,
    scopes: scopesToArray(row.scopes),
  };
}

/** Require a scope (or the "*" superscope), else throw a 403 envelope. */
export function requireScope(principal: Principal, scope: string): void {
  if (principal.scopes.includes("*") || principal.scopes.includes(scope)) return;
  throw new ManifoldError({
    status: 403,
    code: "FORBIDDEN",
    message: `missing required scope '${scope}'`,
    reasonCodes: [],
    remediation: `mint a token carrying the '${scope}' scope`,
    details: { requiredScope: scope, presentedScopes: principal.scopes },
  });
}

/** Authenticate + require a scope in one step. */
export async function authorize(req: Request, scope: string): Promise<Principal> {
  const principal = await authenticate(req);
  requireScope(principal, scope);
  return principal;
}
