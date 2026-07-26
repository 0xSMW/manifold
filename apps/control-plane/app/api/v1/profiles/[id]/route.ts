import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { ControlPlaneContracts } from "@manifold/contracts";
import { profilePublished, TRUSTED_HOST_INVARIANT } from "@/app/api/v1/deployments/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProfileRow {
  id: string;
  installation_id: string;
  hostname: string;
  mode: string;
  network_exposure: string;
  auth_config: unknown;
  network_config: unknown;
  policy_revision_id: string | null;
  default_route_set: unknown;
  disabled_at: string | null;
  installation_disabled_at: string | null;
  active_snapshot: unknown;
  created_at: string;
  updated_at: string;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:read");
    const { id } = await ctx.params;
    const row = await withWorkspace(principal.workspaceId, async (sql) =>
      (await sql<ProfileRow[]>`
        SELECT p.id, p.installation_id, p.hostname, p.mode, p.network_exposure,
               p.auth_config, p.network_config, p.policy_revision_id, p.default_route_set,
               p.disabled_at, i.disabled_at AS installation_disabled_at,
               active.snapshot AS active_snapshot, p.created_at, p.updated_at
        FROM gateway_ingress_profile p
        JOIN gateway_installation i
          ON i.id = p.installation_id AND i.workspace_id = ${principal.workspaceId}
        LEFT JOIN gateway_config_revision active
          ON active.installation_id = p.installation_id
         AND active.workspace_id = ${principal.workspaceId} AND active.status = 'active'
        WHERE p.id = ${id} AND p.workspace_id = ${principal.workspaceId}
        LIMIT 1`)[0] ?? null,
    );
    if (!row) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "profile not found",
        reasonCodes: [],
      });
    }
    const published = profilePublished(row.active_snapshot, row.hostname, row.id);
    return contractOk(ControlPlaneContracts.profiles.detail, {
      id: row.id,
      installationId: row.installation_id,
      hostname: row.hostname,
      mode: row.mode,
      networkExposure: row.network_exposure,
      authConfig: row.auth_config,
      networkConfig: row.network_config,
      policyRevisionId: row.policy_revision_id,
      defaultRouteSet: row.default_route_set,
      published,
      bindingStatus: published ? "published" : "draft",
      available: !row.disabled_at && !row.installation_disabled_at && published,
      status: row.disabled_at ? "disabled" : "active",
      trustedHostInvariant: TRUSTED_HOST_INVARIANT,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }, requestId);
  });
}
