import { drainAuditDelivery, authorizeAuditDeliveryWorker } from "@/lib/audit-delivery";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { InternalContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if (!authorizeAuditDeliveryWorker(req.headers.get("x-manifold-audit-delivery-secret"))) {
      throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing internal delivery secret", reasonCodes: [] });
    }
    const { workspaceId, limit } = await contractBody(req, InternalContracts.auditDelivery);
    return contractOk(InternalContracts.auditDeliveryResponse, await drainAuditDelivery(workspaceId, limit), requestId);
  });
}
