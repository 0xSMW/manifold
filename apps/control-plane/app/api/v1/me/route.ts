// GET /api/v1/me — current console identity and workspace bootstrap data.
import { authenticate } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { MeResponse } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  region: string;
}

interface ProfileRow {
  id: string;
  installation_id: string;
  hostname: string;
  mode: string;
  network_exposure: string;
  installation_name: string;
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authenticate(req);
    const data = await withWorkspace(principal.workspaceId, async (sql) => {
      const workspaces = await sql<WorkspaceRow[]>`
        SELECT id, slug, name, region FROM workspace
        WHERE id = ${principal.workspaceId} LIMIT 1`;
      const profiles = await sql<ProfileRow[]>`
        SELECT p.id, p.installation_id, p.hostname, p.mode, p.network_exposure,
               i.name AS installation_name
        FROM gateway_ingress_profile AS p
        JOIN gateway_installation AS i
          ON i.id = p.installation_id AND i.workspace_id = p.workspace_id
        WHERE p.workspace_id = ${principal.workspaceId}
          AND p.disabled_at IS NULL AND i.disabled_at IS NULL
        ORDER BY i.name, p.hostname`;
      return { workspace: workspaces[0] ?? null, profiles };
    });

    return contractOk(MeResponse,
      {
        member: principal.member ?? null,
        role: principal.member?.role ?? null,
        workspace: data.workspace,
        scopes: principal.scopes,
        availableIngressProfiles: data.profiles.map((profile) => ({
          id: profile.id,
          installationId: profile.installation_id,
          installationName: profile.installation_name,
          hostname: profile.hostname,
          mode: profile.mode,
          networkExposure: profile.network_exposure,
        })),
        sessionExpiresAt: principal.sessionExpiresAt ?? null,
      },
      requestId,
    );
  });
}
