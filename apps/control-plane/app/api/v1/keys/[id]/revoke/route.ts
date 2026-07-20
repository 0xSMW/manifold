// POST /api/v1/keys/{id}/revoke (SPEC §10.3, keys:write, KeyService.revoke).
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { publishKeysOnly } from "@/lib/snapshot";
import { audit } from "@/lib/audit";
import { wrapInEnvelope, ok, ManifoldError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "keys:write");
    const { id } = await ctx.params;

    const row = await withWorkspace(principal.workspaceId, async (sql) => {
      const rows = await sql<{ id: string; profile_id: string }[]>`
        UPDATE virtual_key SET revoked_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
          AND revoked_at IS NULL
        RETURNING id, profile_id`;
      const updated = rows[0];
      if (!updated) return null;
      // Resolve the key's installation so we can scope-publish the revocation.
      const prof = await sql<{ installation_id: string }[]>`
        SELECT installation_id FROM gateway_ingress_profile
        WHERE id = ${updated.profile_id} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
      await audit(sql, principal, {
        action: "key.revoke",
        targetKind: "virtual_key",
        targetId: id,
        requestId,
      });
      return { id: updated.id, installationId: prof[0]?.installation_id ?? null };
    });

    if (!row) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "active virtual key not found",
        reasonCodes: [],
      });
    }

    // Scope-publish the revocation into the active snapshot (§8.2 H7) so the snapshot-only gateway
    // stops accepting the key immediately instead of honoring it for the whole publish lag.
    if (row.installationId) {
      await publishKeysOnly(principal.workspaceId, row.installationId);
    }
    return ok({ id: row.id, revoked: true }, requestId);
  });
}
