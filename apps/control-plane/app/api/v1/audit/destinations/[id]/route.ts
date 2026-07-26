import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { encryptDestination, parseDestination } from "@/lib/audit-destination";
import { withWorkspace } from "@/lib/db";
import { genId } from "@/lib/ids";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { runMutationGuard } from "@/lib/mutation-guard";
import { contractBody, contractOk } from "@/lib/contracts";
import { AuditEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Row { id: string; kind: "webhook" | "siem"; label: string; status: string; disabled_at: string | null; created_at: string; updated_at: string; }
const output = (row: Row) => ({ id: row.id, kind: row.kind, label: row.label, status: row.disabled_at ? "disabled" : row.status, createdAt: row.created_at, updatedAt: row.updated_at, endpoint: { available: false, reason: "encrypted" }, secret: { configured: true, readable: false }, delivery: { available: false, reason: "delivery_worker_unavailable" } });

async function destination(workspaceId: string, id: string): Promise<Row> {
  const row = await withWorkspace(workspaceId, async (sql) => (await sql<Row[]>`SELECT id, kind, label, status, disabled_at, created_at, updated_at FROM audit_destination WHERE workspace_id = ${workspaceId} AND id = ${id} LIMIT 1`)[0]);
  if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "audit destination not found", reasonCodes: [] });
  return row;
}
export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> { return wrapInEnvelope(async (requestId) => { const principal = await authorize(req, "audit:read"); const { id } = await context.params; return contractOk(AuditEndpointContracts.destination, { data: output(await destination(principal.workspaceId, id)) }, requestId); }); }

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:write"); const { id } = await context.params;
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async (sql) => {
      const input = parseDestination(await contractBody(req, AuditEndpointContracts.destinationPatch), true); if (!Object.keys(input).length) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "audit destination request is invalid", reasonCodes: [], details: { issues: [{ path: "body", message: "at least one field is required" }] } });
      const row = (await sql<Row[]>`SELECT id, kind, label, status, disabled_at, created_at, updated_at FROM audit_destination WHERE workspace_id = ${principal.workspaceId} AND id = ${id} LIMIT 1 FOR UPDATE`)[0];
      if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "audit destination not found", reasonCodes: [] });
      let updated: Row | undefined;
      if (input.endpoint !== undefined || input.secret !== undefined) {
      // Re-seal both endpoint and secret under a fresh DEK so updates cannot leave an old wrapped
      // key material reachable. A PATCH without secret intentionally clears no secret.
      if (input.endpoint === undefined) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "endpoint is required when rotating destination encryption", reasonCodes: [], details: { issues: [{ path: "endpoint", message: "required with secret" }] } });
      const encrypted = encryptDestination(id, input.endpoint, input.secret ?? null); const dekId = genId("dek"); const kekId = process.env.MANIFOLD_DATA_KEK_ID ?? "kek_dev";
      await sql`INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES (${dekId}, ${principal.workspaceId}, ${encrypted.wrappedDek}, ${kekId}, 'active')`;
      updated = (await sql<Row[]>`UPDATE audit_destination SET kind = ${input.kind ?? row.kind}, label = ${input.label ?? row.label}, encrypted_endpoint = ${encrypted.endpoint}, encrypted_secret = ${encrypted.secret}, dek_id = ${dekId}, status = 'configured', disabled_at = NULL, updated_at = now() WHERE id = ${id} AND workspace_id = ${principal.workspaceId} RETURNING id, kind, label, status, disabled_at, created_at, updated_at`)[0];
    } else {
      updated = (await sql<Row[]>`UPDATE audit_destination SET kind = ${input.kind ?? row.kind}, label = ${input.label ?? row.label}, updated_at = now() WHERE id = ${id} AND workspace_id = ${principal.workspaceId} RETURNING id, kind, label, status, disabled_at, created_at, updated_at`)[0];
    }
      await audit(sql, principal, { action: "audit_destination.update", targetKind: "audit_destination", targetId: id, requestId, detail: { kind: input.kind ?? row.kind, label: input.label ?? row.label } });
      return contractOk(AuditEndpointContracts.destination, { data: output(updated!) }, requestId);
      },
    });
  });
}
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:write");
    const { id } = await context.params;
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async (sql) => {
        const rows = await sql<{ id: string }[]>`UPDATE audit_destination SET status = 'disabled', disabled_at = now(), updated_at = now() WHERE id = ${id} AND workspace_id = ${principal.workspaceId} AND disabled_at IS NULL RETURNING id`;
        if (!rows[0]) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "audit destination not found", reasonCodes: [] });
        await audit(sql, principal, { action: "audit_destination.disable", targetKind: "audit_destination", targetId: id, requestId });
        return new Response(null, { status: 204 });
      },
    });
  });
}
