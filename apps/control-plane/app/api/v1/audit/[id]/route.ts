import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { serializeAuditEvent, type AuditEventRow } from "@/lib/audit-read";
import { contractOk } from "@/lib/contracts";
import { AuditEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/audit/{id} — a workspace-scoped, redacted audit-event detail projection. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if ([...new URL(req.url).searchParams.keys()].length) {
      throw new ManifoldError({ status: 422, code: "VALIDATION", message: "audit detail does not accept query parameters", reasonCodes: [] });
    }
    const principal = await authorize(req, "audit:read");
    const { id } = await context.params;
    if (!id || id.length > 256) {
      throw new ManifoldError({ status: 422, code: "VALIDATION", message: "audit event id is invalid", reasonCodes: [] });
    }
    const row = await withWorkspace(principal.workspaceId, async (sql) => (await sql<AuditEventRow[]>`
      SELECT id, actor_kind, actor_id, action, target_kind, target_id, before_hash, after_hash,
             request_ref, detail ->> 'outcome' AS outcome, detail ->> 'profileId' AS profile_id,
             chain_version, prev_chain_hash, chain_hash, chain_sealed_at,
             created_at
      FROM audit_event
      WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
      ORDER BY created_at DESC LIMIT 1`)[0] ?? null);
    if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "audit event not found", reasonCodes: [] });
    return contractOk(AuditEndpointContracts.detail, { data: serializeAuditEvent(row) }, requestId);
  });
}
