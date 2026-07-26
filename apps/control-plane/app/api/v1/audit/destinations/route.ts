import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { encryptDestination, parseDestination } from "@/lib/audit-destination";
import { withWorkspace } from "@/lib/db";
import { genId } from "@/lib/ids";
import { jsonBody, ok, wrapInEnvelope } from "@/lib/http";
import { runMutationGuard } from "@/lib/mutation-guard";
import { contractBody, contractOk } from "@/lib/contracts";
import { AuditEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
interface Row { id: string; kind: string; label: string; status: string; disabled_at: string | null; created_at: string; updated_at: string; pending: string; processing: string; delivered: string; dead: string; last_error_code: string | null; }
const output = (row: Row) => ({ id: row.id, kind: row.kind, label: row.label, status: row.disabled_at ? "disabled" : row.status, createdAt: row.created_at, updatedAt: row.updated_at, endpoint: { available: false, reason: "encrypted" }, secret: { configured: true, readable: false }, delivery: { available: !row.disabled_at, state: row.disabled_at ? "disabled" : Number(row.dead) ? "attention" : Number(row.processing) || Number(row.pending) ? "pending" : Number(row.delivered) ? "delivered" : "ready", pending: Number(row.pending), processing: Number(row.processing), delivered: Number(row.delivered), dead: Number(row.dead), lastErrorCode: row.last_error_code } });

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "audit:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) => sql<Row[]>`SELECT d.id, d.kind, d.label, d.status, d.disabled_at, d.created_at, d.updated_at,
      count(*) FILTER (WHERE j.status = 'pending')::text AS pending, count(*) FILTER (WHERE j.status = 'processing')::text AS processing,
      count(*) FILTER (WHERE j.status = 'delivered')::text AS delivered, count(*) FILTER (WHERE j.status = 'dead')::text AS dead,
      (array_agg(j.last_error_code ORDER BY j.updated_at DESC) FILTER (WHERE j.last_error_code IS NOT NULL))[1] AS last_error_code
      FROM audit_destination d LEFT JOIN audit_delivery_job j ON j.destination_id = d.id AND j.workspace_id = d.workspace_id
      WHERE d.workspace_id = ${principal.workspaceId} GROUP BY d.id ORDER BY d.created_at DESC`);
    return contractOk(AuditEndpointContracts.destinationList, { data: rows.map(output) }, requestId);
  });
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:write");
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async (sql) => {
      const input = parseDestination(await contractBody(req, AuditEndpointContracts.destinationCreate)) as Required<ReturnType<typeof parseDestination>>;
      const id = genId("aud_dst");
      const encrypted = encryptDestination(id, input.endpoint, input.secret);
      const kekId = process.env.MANIFOLD_DATA_KEK_ID ?? "kek_dev";
      const dekId = genId("dek");
      await sql`INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES (${dekId}, ${principal.workspaceId}, ${encrypted.wrappedDek}, ${kekId}, 'active')`;
      await sql`INSERT INTO audit_destination (id, workspace_id, kind, label, encrypted_endpoint, encrypted_secret, dek_id) VALUES (${id}, ${principal.workspaceId}, ${input.kind}, ${input.label}, ${encrypted.endpoint}, ${encrypted.secret}, ${dekId})`;
      await audit(sql, principal, { action: "audit_destination.create", targetKind: "audit_destination", targetId: id, requestId, detail: { kind: input.kind, label: input.label } });
      return contractOk(AuditEndpointContracts.destinationCreateResponse, { id, kind: input.kind, label: input.label, status: "configured", endpoint: { available: false, reason: "encrypted" }, secret: { configured: true, readable: false }, delivery: { available: true, state: "ready", pending: 0, processing: 0, delivered: 0, dead: 0, lastErrorCode: null } }, requestId, 201);
      },
    });
  });
}
