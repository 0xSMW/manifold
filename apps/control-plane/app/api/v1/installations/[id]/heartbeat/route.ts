// POST /api/v1/installations/:id/heartbeat — installation-authenticated liveness/reporting.
import { authenticateInstallation } from "@/lib/installation-auth";
import { withWorkspace } from "@/lib/db";
import { jsonBody, ManifoldError, ok, requireString, wrapInEnvelope } from "@/lib/http";
import { assertOnlyFields } from "@/app/api/v1/deployments/_lib";
import { contractBody, contractOk } from "@/lib/contracts";
import { InstallationContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const { id } = await ctx.params;
    const principal = await authenticateInstallation(req, { path: `/api/v1/installations/${id}/heartbeat`, installationId: id });
    const body = await contractBody(req, InstallationContracts.heartbeat);
    const appliedConfigRevision = body.appliedConfigRevision === null || body.appliedConfigRevision === undefined
      ? null
      : requireString(body, "appliedConfigRevision");
    const reportedAt = body.reportedAt === undefined ? new Date() : new Date(requireString(body, "reportedAt"));
    if (!Number.isFinite(reportedAt.getTime()) || Math.abs(Date.now() - reportedAt.getTime()) > 10 * 60 * 1000) {
      throw new ManifoldError({ status: 422, code: "VALIDATION", message: "reportedAt must be a valid timestamp within ten minutes", reasonCodes: [] });
    }
    await withWorkspace(principal.workspaceId, async (sql) => {
      const rows = await sql<{ id: string }[]>`
        UPDATE gateway_installation
        SET applied_config_revision = ${appliedConfigRevision}, last_seen_at = ${reportedAt.toISOString()}, updated_at = now()
        WHERE id = ${principal.installationId} AND workspace_id = ${principal.workspaceId} AND disabled_at IS NULL
        RETURNING id`;
      if (!rows[0]) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "installation not found", reasonCodes: [] });
    });
    return contractOk(InstallationContracts.heartbeatResponse, { installationId: principal.installationId, appliedConfigRevision, observedAt: reportedAt.toISOString() }, requestId);
  });
}
