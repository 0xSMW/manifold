import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { authorizeSettings } from "@/lib/settings/access";
import { audit } from "@/lib/audit";
import { generateSecret } from "@/lib/crypto";
import { genId } from "@/lib/ids";
import { runMutationGuard } from "@/lib/mutation-guard";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { expiry, validatedTokenScopes } from "@/lib/settings/human-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Row = { id: string; display_prefix: string; scopes: unknown; created_by: string | null; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; created_at: string; kind: "legacy" | "personal" | "service"; label: string | null };

export async function GET(req: Request) {
  return wrapInEnvelope(async (requestId) => {
    const { cursor, limit } = contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.pageQuery);
    const principal = await authorizeSettings(req, "config:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) => sql<Row[]>`SELECT id,display_prefix,scopes,created_by,expires_at,revoked_at,last_used_at,created_at,kind,label FROM api_token WHERE workspace_id=${principal.workspaceId} AND (${cursor}::text IS NULL OR id<${cursor}) ORDER BY id DESC LIMIT ${limit + 1}`);
    const data = rows.slice(0, limit).map((row) => ({ id: row.id, displayPrefix: row.display_prefix, scopes: Array.isArray(row.scopes) ? row.scopes : [], createdByMemberId: row.created_by, expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at, createdAt: row.created_at, kind: row.kind === "service" ? "serviceAccount" : row.kind, name: row.label }));
    return contractOk(SettingsEndpointContracts.tokenList, { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null }, requestId);
  });
}

export async function POST(req: Request) {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorizeSettings(req, "config:write");
    return runMutationGuard({ request: req, principal, requestId, sensitiveReplay: true, rateLimit: { limit: 10, windowMs: 60_000 }, handler: async (sql) => {
      contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery);
      const body = await contractBody(req, SettingsEndpointContracts.tokenMint);
      if (!body.name) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "a token name is required", reasonCodes: [] });
      const userId = principal.userId;
      if (!userId) throw new ManifoldError({ status: 409, code: "VALIDATION", message: "personal token minting requires a human user session", reasonCodes: ["USER_ID_REQUIRED"] });
      const scopes = validatedTokenScopes(principal, body.scopes);
      const secret = generateSecret("mf_tok_"); const expiresAt = expiry(body.expiresAt); const id = genId("tok");
      await sql`INSERT INTO api_token (id,workspace_id,display_prefix,keyed_hash,scopes,created_by,expires_at,kind,label,user_id) VALUES (${id},${principal.workspaceId},${secret.displayPrefix},${secret.keyedHash},${sql.json(scopes as never)},${principal.member!.id},${expiresAt},'personal',${body.name},${userId})`;
      await audit(sql, principal, { action: "api_token.mint", targetKind: "api_token", targetId: id, requestId, detail: { scopes, expiresAt } });
      return contractOk(SettingsEndpointContracts.tokenMintResponse, { data: { id, displayPrefix: secret.displayPrefix, scopes, expiresAt, kind: "personal", name: body.name, plaintext: secret.plaintext } }, requestId, 201);
    } });
  });
}
