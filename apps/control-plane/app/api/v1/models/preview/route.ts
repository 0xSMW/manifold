import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { ModelsApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Profile = { id: string; installation_id: string; hostname: string; disabled_at: string | null; installation_disabled_at: string | null };
type Model = { id: string; public_name: string; endpoint_kind: string; canonical_id: string; canonical_slug: string; provider_model_id: string; provider: string };

/** A control-plane preview of the names a deployed profile would expose after Publish. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "registry:read");
    const profileId = new URL(req.url).searchParams.get("profileId");
    if (!profileId) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "profileId is required", reasonCodes: [], details: { issues: [{ path: "profileId", message: "required" }] } });
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const profile = (await sql<Profile[]>`SELECT p.id, p.installation_id, p.hostname, p.disabled_at, i.disabled_at AS installation_disabled_at FROM gateway_ingress_profile p JOIN gateway_installation i ON i.id = p.installation_id WHERE p.id = ${profileId} AND p.workspace_id = ${principal.workspaceId} LIMIT 1`)[0];
      if (!profile) return null;
      const models = await sql<Model[]>`SELECT DISTINCT ON (r.endpoint_kind, r.public_name) r.id, r.public_name, r.endpoint_kind, c.id AS canonical_id, c.canonical_slug, o.provider_model_id, o.provider FROM gateway_route r JOIN gateway_route_revision rr ON rr.id = r.active_revision_id AND rr.workspace_id = ${principal.workspaceId} JOIN gateway_target t ON t.route_revision_id = rr.id AND t.workspace_id = ${principal.workspaceId} JOIN provider_model_offering o ON o.id = t.offering_id JOIN canonical_model c ON c.id = o.canonical_model_id WHERE r.workspace_id = ${principal.workspaceId} AND r.installation_id = ${profile.installation_id} AND r.disabled_at IS NULL ORDER BY r.endpoint_kind, r.public_name, t.priority ASC, t.id ASC`;
      return { profile, models };
    });
    if (!result) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "ingress profile not found", reasonCodes: [] });
    const available = !result.profile.disabled_at && !result.profile.installation_disabled_at;
    return contractOk(ModelsApi.previewResponse, { profile: { id: result.profile.id, hostname: result.profile.hostname, available }, data: result.models.map((model) => ({ id: model.id, model: model.public_name, endpointKind: model.endpoint_kind, canonicalModel: { id: model.canonical_id, slug: model.canonical_slug }, provider: model.provider, providerModelId: model.provider_model_id })), publishRequired: true, note: "This is a control-plane preview from staged route revisions. The gateway serves only the published signed snapshot." }, requestId);
  });
}
