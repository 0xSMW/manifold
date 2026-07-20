// POST /api/v1/providers/{id}/validate (SPEC §10.3, providers:write).
//
// STUB: a real validate does an upstream provider call OUTSIDE the DB txn (§10.5) and records
// the result. Here we mark the credential 'valid' and stamp last_validated_at, so downstream
// routing has a validated credential to reference. No egress is performed.
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { audit } from "@/lib/audit";
import { wrapInEnvelope, ok, ManifoldError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UpdatedRow {
  id: string;
  status: string;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "providers:write");
    const { id } = await ctx.params;

    const row = await withWorkspace(principal.workspaceId, async (sql) => {
      const rows = await sql<UpdatedRow[]>`
        UPDATE provider_credential
        SET status = 'valid', last_validated_at = now(), updated_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
          AND revoked_at IS NULL
        RETURNING id, status`;
      const updated = rows[0];
      if (updated) {
        await audit(sql, principal, {
          action: "provider.validate",
          targetKind: "provider_credential",
          targetId: id,
          requestId,
          detail: { stub: true },
        });
      }
      return updated ?? null;
    });

    if (!row) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "provider credential not found",
        reasonCodes: [],
      });
    }
    return ok({ id: row.id, status: row.status, validated: true, stub: true }, requestId);
  });
}
