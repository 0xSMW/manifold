// POST /api/v1/keys/{id}/revoke (SPEC §10.3, keys:write, KeyService.revoke).
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { audit } from "@/lib/audit";
import { handle, ok, ManifoldError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "keys:write");
    const { id } = await ctx.params;

    const row = await withWorkspace(principal.workspaceId, async (sql) => {
      const rows = await sql<{ id: string }[]>`
        UPDATE virtual_key SET revoked_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
          AND revoked_at IS NULL
        RETURNING id`;
      const updated = rows[0];
      if (updated) {
        await audit(sql, principal, {
          action: "key.revoke",
          targetKind: "virtual_key",
          targetId: id,
          requestId,
        });
      }
      return updated ?? null;
    });

    if (!row) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "active virtual key not found",
        reasonCodes: [],
      });
    }
    return ok({ id: row.id, revoked: true }, requestId);
  });
}
