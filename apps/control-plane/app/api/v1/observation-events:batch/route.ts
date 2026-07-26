import { authenticateInstallation } from "@/lib/installation-auth";
import { ingestBatch, parseBatch } from "@/lib/observation-ingest";
import { contractOk, contractValue } from "@/lib/contracts";
import { jsonBody, wrapInEnvelope } from "@/lib/http";
import { ObservationIngestContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    // Authenticate before parsing the body: installation identity is the only tenant selector.
    const principal = await authenticateInstallation(req, { path: "/api/v1/observation-events:batch" });
    const body = await jsonBody(req);
    // Preserve the ingest protocol's precise rejection reasons for producer
    // identity attempts and batch bounds before the closed wire schema handles
    // all other unknown or malformed fields.
    const events = parseBatch(body);
    contractValue(body, ObservationIngestContracts.batch);
    const result = await ingestBatch({ workspaceId: principal.workspaceId, installationId: principal.installationId, events });
    return contractOk(ObservationIngestContracts.accepted, result, requestId, 202);
  });
}
