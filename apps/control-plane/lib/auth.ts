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

export type PrincipalActorKind = "api_token" | "member";

export interface PrincipalMember {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface Principal {
  workspaceId: string;
  scopes: string[];
  actorKind: PrincipalActorKind;
  actorId: string;
  /** Present for browser sessions; bearer tokens deliberately remain token principals. */
  member?: PrincipalMember;
  /** Present for browser sessions. Never contains the source API token. */
  sessionId?: string;
  sessionExpiresAt?: string;
  /** Kept for bearer-token callers that need the token identity. */
  tokenId?: string;
}

interface ApiTokenRow {
  id: string;
  workspace_id: string;
  scopes: unknown;
  revoked_at: string | null;
  expires_at: string | null;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  member_id: string;
  member_email: string;
  member_name: string | null;
  member_role: string;
  member_disabled_at: string | null;
  scopes: unknown;
  expires_at: string;
  revoked_at: string | null;
}

function scopesToArray(scopes: unknown): string[] {
  if (Array.isArray(scopes)) return scopes.map(String);
  if (scopes && typeof scopes === "object") return Object.keys(scopes as object);
  return [];
}

const VIEWER_SCOPES = new Set([
  "routes:read",
  "observations:read",
  "registry:read",
  "budgets:read",
  "audit:read",
  "system:read",
]);
const EDITOR_SCOPES = new Set([
  ...VIEWER_SCOPES,
  "routes:write",
  "keys:read",
  "keys:write",
  "providers:read",
  "providers:write",
  "policies:read",
  "policies:write",
  "budgets:write",
  "registry:write",
  "config:read",
]);
const ADMIN_SCOPES = new Set([
  ...EDITOR_SCOPES,
  "policies:approve",
  "config:write",
  "storage:read",
  "storage:write",
  "deployments:read",
  "deployments:write",
  "cli:approve",
]);
const BILLING_SCOPES = new Set(["budgets:read", "audit:read"]);

/** Apply the member's current role ceiling to the session's original token scopes. */
function scopesForRole(scopes: unknown, role: string): string[] {
  const requested = scopesToArray(scopes);
  if (role === "owner") return requested;
  const allowed =
    role === "admin"
      ? ADMIN_SCOPES
      : role === "editor"
        ? EDITOR_SCOPES
        : role === "viewer"
          ? VIEWER_SCOPES
          : role === "billing"
            ? BILLING_SCOPES
            : new Set<string>();
  return requested.filter((scope) => allowed.has(scope));
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

/** Resolve only a bearer api_token. Login uses this to prevent cookie re-login. */
export async function authenticateBearer(req: Request): Promise<Principal> {
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
    actorKind: "api_token",
    actorId: row.id,
  };
}

function cookieValue(req: Request, name: string): string | null {
  const cookies = req.headers.get("cookie");
  if (!cookies) return null;
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

/** Resolve an HttpOnly browser-session cookie through its exact keyed hash. */
export async function authenticateSession(req: Request): Promise<Principal> {
  const session = cookieValue(req, "manifold_session");
  if (!session) throw unauthenticated("AUTH_SESSION_UNKNOWN", "missing browser session");

  const rows = await rawSql()<SessionRow[]>`
    SELECT id, workspace_id, member_id, member_email, member_name, member_role,
           member_disabled_at, scopes, expires_at, revoked_at
    FROM auth_lookup_console_session(${keyedHash(session)})`;
  const row = rows[0];
  if (!row) throw unauthenticated("AUTH_SESSION_UNKNOWN", "unknown browser session");
  if (row.revoked_at) throw unauthenticated("AUTH_SESSION_REVOKED", "browser session revoked");
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw unauthenticated("AUTH_SESSION_EXPIRED", "browser session expired");
  }
  if (row.member_disabled_at) {
    throw unauthenticated("AUTH_MEMBER_DISABLED", "member is disabled");
  }

  rawSql()`SELECT auth_touch_console_session(${row.id})`.catch(() => {});
  return {
    workspaceId: row.workspace_id,
    scopes: scopesForRole(row.scopes, row.member_role),
    actorKind: "member",
    actorId: row.member_id,
    sessionId: row.id,
    sessionExpiresAt: row.expires_at,
    member: {
      id: row.member_id,
      email: row.member_email,
      name: row.member_name,
      role: row.member_role,
    },
  };
}

/** Resolve a bearer token when supplied; otherwise fall back to the browser session cookie. */
export async function authenticate(req: Request): Promise<Principal> {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header ? authenticateBearer(req) : authenticateSession(req);
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
