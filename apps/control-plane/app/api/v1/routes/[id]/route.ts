import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { wrapInEnvelope, ok, ManifoldError } from "@/lib/http";
import { contractOk, contractOptionalEmptyBody } from "@/lib/contracts";
import { RoutesApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "routes:read");
    const { id } = await context.params;
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const routes = await sql<any[]>`SELECT r.id, r.installation_id, r.public_name, r.endpoint_kind, r.active_revision_id, r.disabled_at, r.created_at, r.updated_at, i.name AS installation_name FROM gateway_route r JOIN gateway_installation i ON i.id = r.installation_id AND i.workspace_id = ${principal.workspaceId} WHERE r.id = ${id} AND r.workspace_id = ${principal.workspaceId} LIMIT 1`;
      const route = routes[0]; if (!route) return null;
      const revisions = await sql<any[]>`SELECT id, mode, retry_policy, timeout_policy, capture_policy, content_hash, created_by, created_at FROM gateway_route_revision WHERE route_id = ${id} AND workspace_id = ${principal.workspaceId} ORDER BY created_at DESC, id DESC`;
      const targets = revisions.length === 0 ? [] : await sql<any[]>`SELECT t.id, t.route_revision_id, t.provider_credential_id, t.offering_id, t.adapter_revision, t.base_url, t.deployment, t.region, t.weight, t.priority, t.health_state, t.created_at, c.provider, c.label AS credential_label, c.status AS credential_status, c.revoked_at AS credential_revoked_at, o.provider_model_id FROM gateway_target t JOIN provider_credential c ON c.id = t.provider_credential_id AND c.workspace_id = ${principal.workspaceId} JOIN provider_model_offering o ON o.id = t.offering_id WHERE t.workspace_id = ${principal.workspaceId} AND t.route_revision_id IN ${sql(revisions.map((revision) => revision.id))}`;
      return { route, revisions, targets };
    });
    if (!result) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "route not found", reasonCodes: [] });
    return contractOk(RoutesApi.detailResponse, { id: result.route.id, installationId: result.route.installation_id, installationName: result.route.installation_name, publicName: result.route.public_name, endpointKind: result.route.endpoint_kind, activeRevisionId: result.route.active_revision_id, status: result.route.disabled_at ? "disabled" : result.route.active_revision_id ? "staged" : "draft", disabledAt: result.route.disabled_at, createdAt: result.route.created_at, updatedAt: result.route.updated_at, revisions: result.revisions.map((revision) => ({ id: revision.id, mode: revision.mode, retryPolicy: revision.retry_policy, timeoutPolicy: revision.timeout_policy, capturePolicy: revision.capture_policy, contentHash: revision.content_hash, createdBy: revision.created_by, createdAt: revision.created_at, isActive: revision.id === result.route.active_revision_id, targets: result.targets.filter((target) => target.route_revision_id === revision.id).map((target) => ({ id: target.id, providerCredentialId: target.provider_credential_id, offeringId: target.offering_id, provider: target.provider, credentialLabel: target.credential_label, credentialStatus: target.credential_revoked_at ? "revoked" : target.credential_status, providerModelId: target.provider_model_id, adapterRevision: target.adapter_revision, baseUrl: target.base_url, deployment: target.deployment, region: target.region, weight: target.weight, priority: target.priority, healthState: target.health_state, createdAt: target.created_at })) })) }, requestId);
  });
}

/** Soft deletion only. The desired snapshot changes here; config/apply owns the publish tripwire. */
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "routes:write"); const { id } = await context.params; return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 20, windowMs: 60_000 }, handler: async (sql) => {
    await contractOptionalEmptyBody(req, RoutesApi.emptyRequest);
    const { audit } = await import("@/lib/audit");
    const changed = await (async () => {
      const rows = await sql<{ id: string; disabled_at: string | null }[]>`SELECT id, disabled_at FROM gateway_route WHERE id = ${id} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
      if (!rows[0]) return null;
      if (!rows[0].disabled_at) { await sql`UPDATE gateway_route SET disabled_at = now(), updated_at = now() WHERE id = ${id} AND workspace_id = ${principal.workspaceId}`; await audit(sql, principal, { action: "route.disable", targetKind: "gateway_route", targetId: id, requestId }); }
      return rows[0].disabled_at === null;
    })();
    if (changed === null) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "route not found", reasonCodes: [] });
    return contractOk(RoutesApi.disableResponse, { id, status: "disabled", changed, publishRequired: true }, requestId); }});
  });
}
