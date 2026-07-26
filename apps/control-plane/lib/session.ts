import { randomBytes } from "node:crypto";
import { authenticateBearer, type Principal } from "@/lib/auth";
import { keyedHash } from "@/lib/crypto";
import { withWorkspace } from "@/lib/db";
import { genId } from "@/lib/ids";
import { ManifoldError } from "@/lib/http";

export const SESSION_COOKIE = "manifold_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;

interface TokenMemberRow {
  member_id: string | null;
  email: string | null;
  name: string | null;
  role: string | null;
  disabled_at: string | null;
}

export interface CreatedSession {
  plaintext: string;
  expiresAt: string;
  member: { id: string; email: string; name: string | null; role: string };
}

function loginDenied(message: string): ManifoldError {
  return new ManifoldError({
    status: 401,
    code: "UNAUTHENTICATED",
    message,
    reasonCodes: ["AUTH_MEMBER_REQUIRED"],
    remediation: "present an active API token created by an enabled workspace member",
  });
}

/** Exchange a bearer token for a fresh opaque browser session. */
export async function createSession(req: Request): Promise<CreatedSession> {
  const token = await authenticateBearer(req);
  if (!token.tokenId) throw loginDenied("API token identity unavailable");
  const tokenId = token.tokenId;
  const plaintext = randomBytes(32).toString("base64url");
  const sessionId = genId("ses");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  return withWorkspace(token.workspaceId, async (sql) => {
    // This tenant-scoped read proves that the token has a real, enabled member
    // owner at issuance time. The source token is neither selected as plaintext
    // nor recorded in console_session.
    const rows = await sql<TokenMemberRow[]>`
      SELECT t.created_by AS member_id, m.email, m.name, m.role, m.disabled_at
      FROM api_token AS t
      LEFT JOIN member AS m ON m.id = t.created_by AND m.workspace_id = t.workspace_id
      WHERE t.id = ${tokenId} AND t.workspace_id = ${token.workspaceId}
      LIMIT 1`;
    const member = rows[0];
    if (!member?.member_id || !member.email || !member.role || member.disabled_at) {
      throw loginDenied("API token is not linked to an enabled member");
    }

    await sql`
      INSERT INTO console_session
        (id, workspace_id, member_id, keyed_hash, scopes, expires_at)
      VALUES
        (${sessionId}, ${token.workspaceId}, ${member.member_id}, ${keyedHash(plaintext)},
         ${sql.json(token.scopes as never)}, ${expiresAt})`;
    return {
      plaintext,
      expiresAt,
      member: { id: member.member_id, email: member.email, name: member.name, role: member.role },
    };
  });
}

/** Revoke this exact session under RLS. Missing/expired cookies are intentionally idempotent. */
export async function revokeSession(principal: Principal): Promise<void> {
  if (principal.actorKind !== "member" || !principal.sessionId) return;
  const sessionId = principal.sessionId;
  await withWorkspace(principal.workspaceId, async (sql) => {
    await sql`
      UPDATE console_session SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = ${sessionId} AND workspace_id = ${principal.workspaceId}`;
  });
}

export function sessionCookie(value: string, expiresAt: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}
