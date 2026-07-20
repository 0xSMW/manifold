// GET/POST /api/v1/keys — virtual keys (SPEC §10.3, §9.2 KeyService.mint).
//   GET  keys:read  — list this workspace's virtual keys (never the plaintext).
//   POST keys:write — mint a key: generate plaintext, store keyed_hash (HMAC, §14.3) +
//     display_prefix; return the plaintext EXACTLY ONCE.
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { publishKeysOnly } from "@/lib/snapshot";
import { audit } from "@/lib/audit";
import { generateSecret } from "@/lib/crypto";
import { genId } from "@/lib/ids";
import {
  handle,
  jsonBody,
  ok,
  requireString,
  optionalString,
  optionalStringArray,
  ManifoldError,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface KeyRow {
  id: string;
  display_prefix: string;
  profile_id: string;
  scopes: unknown;
  budget_account_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export async function GET(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "keys:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<KeyRow[]>`
        SELECT id, display_prefix, profile_id, scopes, budget_account_id,
               expires_at, revoked_at, created_at
        FROM virtual_key
        WHERE workspace_id = ${principal.workspaceId}
        ORDER BY created_at DESC`,
    );
    return ok(
      {
        data: rows.map((r) => ({
          id: r.id,
          displayPrefix: r.display_prefix,
          profileId: r.profile_id,
          scopes: r.scopes,
          budgetAccountId: r.budget_account_id,
          expiresAt: r.expires_at,
          revoked: r.revoked_at != null,
          createdAt: r.created_at,
        })),
        nextCursor: null,
      },
      requestId,
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "keys:write");
    const body = await jsonBody(req);
    const profileId = requireString(body, "profileId");
    const scopes = optionalStringArray(body, "scopes");
    const allowedAppIds = optionalStringArray(body, "allowedAppIds");
    const budgetAccountId = optionalString(body, "budgetAccountId");
    const expiresAt = optionalString(body, "expiresAt");

    const secret = generateSecret("sk-mf-");
    const keyId = genId("key");

    const created = await withWorkspace(principal.workspaceId, async (sql) => {
      // Profile must belong to this workspace (else cross-tenant / unknown → 404). Also grab its
      // installation so we can scope-publish the key into the active snapshot after minting.
      const profiles = await sql<{ id: string; installation_id: string }[]>`
        SELECT id, installation_id FROM gateway_ingress_profile
        WHERE id = ${profileId} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
      if (!profiles[0]) return { error: "profile" as const };
      const installationId = profiles[0].installation_id;

      // Cross-tenant reference guard (§15.2): a caller-supplied budgetAccountId / allowedAppIds
      // must belong to THIS workspace. An FK existence check alone would let a key link to another
      // workspace's budget or app. The predicates are workspace-scoped (also enforced by RLS), so a
      // ref owned by another tenant resolves to zero rows → reject before storing.
      if (budgetAccountId) {
        const ba = await sql<{ id: string }[]>`
          SELECT id FROM budget_account
          WHERE id = ${budgetAccountId} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
        if (!ba[0]) return { error: "budgetAccount" as const };
      }
      for (const appId of allowedAppIds) {
        const app = await sql<{ id: string }[]>`
          SELECT id FROM app
          WHERE id = ${appId} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
        if (!app[0]) return { error: "app" as const };
      }

      await sql`
        INSERT INTO virtual_key
          (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes,
           allowed_app_ids, budget_account_id, expires_at)
        VALUES
          (${keyId}, ${principal.workspaceId}, ${profileId}, ${secret.displayPrefix},
           ${secret.keyedHash}, ${sql.json(scopes as never)},
           ${sql.json(allowedAppIds as never)}, ${budgetAccountId}, ${expiresAt})`;

      await audit(sql, principal, {
        action: "key.mint",
        targetKind: "virtual_key",
        targetId: keyId,
        requestId,
        detail: { profileId, scopes },
      });
      return { keyId, installationId };
    });

    if ("error" in created) {
      if (created.error === "profile") {
        throw new ManifoldError({
          status: 404,
          code: "NOT_FOUND",
          message: "ingress profile not found",
          reasonCodes: [],
        });
      }
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: `${created.error} does not belong to this workspace`,
        reasonCodes: [],
        details: { issues: [{ path: created.error, message: "unknown or cross-tenant reference" }] },
      });
    }

    // Scope-publish the new key into the active snapshot (§8.2 H7) so the snapshot-only gateway
    // authenticates it immediately instead of returning AUTH_KEY_UNKNOWN until a full apply.
    await publishKeysOnly(principal.workspaceId, created.installationId);

    // Plaintext returned exactly once (§9.2). Never retrievable again.
    return ok(
      {
        keyId,
        displayPrefix: secret.displayPrefix,
        plaintext: secret.plaintext,
      },
      requestId,
      201,
    );
  });
}
