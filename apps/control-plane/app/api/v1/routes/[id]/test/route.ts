import { profilePublished } from "@/app/api/v1/deployments/_lib";
import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { errorEnvelope, jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { runMutationGuard } from "@/lib/mutation-guard";
import { executeSyntheticGatewayRequest, SyntheticTestError, type SyntheticEndpointKind } from "@/lib/synthetic-test";
import { executionFailureAuditDetail, gatewayResponseAuditDetail, type SyntheticFailureCode } from "@/lib/synthetic-test-audit";
import { contractBody, contractOk } from "@/lib/contracts";
import { RoutesApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteRow { id: string; installation_id: string; public_name: string; endpoint_kind: SyntheticEndpointKind; disabled_at: string | null; installation_disabled_at: string | null; applied_config_revision: string | null; }
interface ProfileRow { id: string; hostname: string; mode: string; disabled_at: string | null; }

function precondition(message: string, reasonCode: string): never {
  throw new ManifoldError({ status: 409, code: "CONFIG_PRECONDITION_FAILED", message, reasonCodes: [reasonCode] });
}

function snapshotContainsRoute(snapshot: unknown, profile: ProfileRow, route: RouteRow): boolean {
  if (!profilePublished(snapshot, profile.hostname, profile.id) || !snapshot || typeof snapshot !== "object") return false;
  const routes = (snapshot as { routes?: unknown }).routes;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return false;
  const entry = (routes as Record<string, unknown>)[`${profile.id}:${route.endpoint_kind}:${route.public_name}`];
  return !!entry && typeof entry === "object" && (entry as { routeId?: unknown }).routeId === route.id;
}

/** Send one authenticated, bounded request through the published gateway route. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "routes:write");
    const { id } = await context.params;
    const body = await contractBody(req.clone(), RoutesApi.testRequest);
    const unknown = Object.keys(body).filter((key) => key !== "profileId");
    if (unknown.length || (body.profileId !== undefined && (typeof body.profileId !== "string" || !body.profileId))) {
      throw new ManifoldError({ status: 422, code: "VALIDATION", message: "profileId must be an optional non-empty string", reasonCodes: [], details: { issues: [{ path: unknown[0] ?? "profileId", message: "invalid field" }] } });
    }
    const requestedProfileId = typeof body.profileId === "string" ? body.profileId : null;

    return runMutationGuard({
      request: req,
      principal,
      requestId,
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async (sql) => {
        const route = (await sql<RouteRow[]>`
          SELECT r.id, r.installation_id, r.public_name, r.endpoint_kind, r.disabled_at,
                 i.disabled_at AS installation_disabled_at, i.applied_config_revision
          FROM gateway_route r JOIN gateway_installation i ON i.id = r.installation_id
          WHERE r.id = ${id} AND r.workspace_id = ${principal.workspaceId}
            AND i.workspace_id = ${principal.workspaceId} LIMIT 1`)[0];
        if (!route) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "route not found", reasonCodes: [] });
        if (route.disabled_at || route.installation_disabled_at) precondition("route or installation is disabled", "ROUTE_DISABLED");

        const active = (await sql<{ id: string; snapshot: unknown }[]>`
          SELECT id, snapshot FROM gateway_config_revision
          WHERE installation_id = ${route.installation_id} AND workspace_id = ${principal.workspaceId}
            AND status = 'active' LIMIT 1`)[0];
        if (!active) precondition("route testing requires a published active configuration", "CONFIG_NOT_PUBLISHED");
        const profiles = await sql<ProfileRow[]>`
          SELECT id, hostname, mode, disabled_at FROM gateway_ingress_profile
          WHERE installation_id = ${route.installation_id} AND workspace_id = ${principal.workspaceId}
            AND disabled_at IS NULL ORDER BY hostname`;
        const candidates = profiles.filter((profile) => snapshotContainsRoute(active.snapshot, profile, route));
        const profile = requestedProfileId
          ? candidates.find((candidate) => candidate.id === requestedProfileId)
          : candidates.length === 1 ? candidates[0] : undefined;
        if (!profile) {
          precondition(
            requestedProfileId ? "selected ingress profile is not published for this route" : "select a published ingress profile for this route",
            requestedProfileId ? "PROFILE_ROUTE_BINDING_MISSING" : "PROFILE_SELECTION_REQUIRED",
          );
        }

        let result;
        try {
          result = await executeSyntheticGatewayRequest({
            gatewayUrl: process.env.MANIFOLD_GATEWAY_DIAGNOSTICS_URL,
            diagnosticsToken: process.env.MANIFOLD_GATEWAY_DIAGNOSTICS_TOKEN,
            hostname: profile.hostname,
            endpointKind: route.endpoint_kind,
            publicName: route.public_name,
          });
        } catch (error) {
          const failureCode: SyntheticFailureCode = error instanceof SyntheticTestError
            ? error.code
            : "SYNTHETIC_EXECUTION_FAILED";
          await audit(sql, principal, {
            action: "route.synthetic_test",
            targetKind: "gateway_route",
            targetId: route.id,
            requestId,
            detail: executionFailureAuditDetail({
              installationId: route.installation_id,
              profileId: profile.id,
              endpointKind: route.endpoint_kind,
              configRevisionId: active.id,
              appliedConfigRevisionId: route.applied_config_revision,
            }, failureCode),
          });
          const retryable = failureCode === "SYNTHETIC_TIMEOUT" || failureCode === "SYNTHETIC_NETWORK" || failureCode === "SYNTHETIC_EXECUTION_FAILED";
          return errorEnvelope(new ManifoldError({
            status: failureCode === "SYNTHETIC_NOT_CONFIGURED" ? 503 : 502,
            code: "CONFIG_PRECONDITION_FAILED",
            message: error instanceof SyntheticTestError ? error.message : "gateway diagnostic request failed",
            reasonCodes: [failureCode],
            retryable,
          }), requestId);
        }
        await audit(sql, principal, {
          action: "route.synthetic_test",
          targetKind: "gateway_route",
          targetId: route.id,
          requestId,
          detail: gatewayResponseAuditDetail({
            installationId: route.installation_id,
            profileId: profile.id,
            endpointKind: route.endpoint_kind,
            configRevisionId: active.id,
            appliedConfigRevisionId: route.applied_config_revision,
          }, result),
        });
        return contractOk(RoutesApi.testResponse, { routeId: route.id, installationId: route.installation_id, profile: { id: profile.id, hostname: profile.hostname, mode: profile.mode }, status: result.gatewayStatus >= 200 && result.gatewayStatus < 300 ? "completed" : "gateway_error", gatewayStatus: result.gatewayStatus, traceId: result.traceId, logsHref: result.traceId ? `/logs/${encodeURIComponent(result.traceId)}` : null, responseTruncated: result.responseTruncated }, requestId);
      },
    });
  });
}
