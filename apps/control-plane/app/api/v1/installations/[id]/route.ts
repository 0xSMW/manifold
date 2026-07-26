import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { audit } from "@/lib/audit";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { InstallationContracts } from "@manifold/contracts";
import {
  assertOnlyFields,
  enumField,
  INSTALLATION_EDITIONS,
  profilePublished,
  TRUSTED_HOST_INVARIANT,
} from "@/app/api/v1/deployments/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InstallationRow { id: string; name: string; edition: string; applied_config_revision: string | null; last_seen_at: string | null; disabled_at: string | null; created_at: string; }
interface ProfileRow { id: string; hostname: string; mode: string; network_exposure: string; auth_config: unknown; network_config: unknown; policy_revision_id: string | null; default_route_set: unknown; disabled_at: string | null; created_at: string; }
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:read");
    const { id } = await ctx.params;
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const installation = (await sql<InstallationRow[]>`SELECT id, name, edition, applied_config_revision, last_seen_at, disabled_at, created_at FROM gateway_installation WHERE id = ${id} AND workspace_id = ${principal.workspaceId} LIMIT 1`)[0];
      if (!installation) return null;
      const profiles = await sql<ProfileRow[]>`SELECT id, hostname, mode, network_exposure, auth_config, network_config, policy_revision_id, default_route_set, disabled_at, created_at FROM gateway_ingress_profile WHERE installation_id = ${id} AND workspace_id = ${principal.workspaceId} ORDER BY hostname`;
      const active = (await sql<{ id: string; snapshot: unknown }[]>`
        SELECT id, snapshot FROM gateway_config_revision
        WHERE installation_id = ${id} AND workspace_id = ${principal.workspaceId}
          AND status = 'active' LIMIT 1`)[0] ?? null;
      return { installation, profiles, active };
    });
    if (!result) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "installation not found", reasonCodes: [] });
    const i = result.installation;
    return contractOk(InstallationContracts.detailResponse, { id: i.id, name: i.name, edition: i.edition, appliedConfigRevision: i.applied_config_revision, activeConfigRevision: result.active?.id ?? null, lastSeenAt: i.last_seen_at, status: i.disabled_at ? "disabled" : "active", createdAt: i.created_at, trustedHostInvariant: TRUSTED_HOST_INVARIANT, profiles: result.profiles.map((p) => {
      const published = profilePublished(result.active?.snapshot, p.hostname, p.id);
      return { id: p.id, hostname: p.hostname, mode: p.mode, networkExposure: p.network_exposure, authConfig: p.auth_config, networkConfig: p.network_config, policyRevisionId: p.policy_revision_id, defaultRouteSet: p.default_route_set, published, bindingStatus: published ? "published" : "draft", available: !p.disabled_at && !i.disabled_at && published, status: p.disabled_at ? "disabled" : "active", trustedHostInvariant: TRUSTED_HOST_INVARIANT, createdAt: p.created_at };
    }) }, requestId);
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:write");
    requireMutationIdempotencyKey(req);
    const { id } = await ctx.params;
    const body = await contractBody(req.clone(), InstallationContracts.update);
    const rawBody = body as Record<string, unknown>;
    let name: string | null = null;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new ManifoldError({
          status: 422,
          code: "VALIDATION",
          message: "name must contain non-whitespace characters",
          reasonCodes: [],
          details: { issues: [{ path: "name", message: "non-whitespace string required" }] },
        });
      }
      name = body.name.trim();
    }
    const edition = body.edition === undefined
      ? null
      : enumField(rawBody, "edition", INSTALLATION_EDITIONS);

    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 30, windowMs: 60_000 }, handler: async (sql) => {
    const updated = await (async () => {
      const before = (await sql<{ name: string; edition: string }[]>`
        SELECT name, edition FROM gateway_installation
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId} LIMIT 1`)[0];
      if (!before) return null;
      const row = (await sql<{ id: string; name: string; edition: string; disabled_at: string | null; updated_at: string }[]>`
        UPDATE gateway_installation
        SET name = CASE WHEN ${name !== null} THEN ${name} ELSE name END,
            edition = CASE WHEN ${edition !== null} THEN ${edition} ELSE edition END,
            updated_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
        RETURNING id, name, edition, disabled_at, updated_at`)[0]!;
      await audit(sql, principal, {
        action: "installation.update",
        targetKind: "gateway_installation",
        targetId: id,
        requestId,
        detail: {
          changedFields: [
            ...(name !== null && name !== before.name ? ["name"] : []),
            ...(edition !== null && edition !== before.edition ? ["edition"] : []),
          ],
        },
      });
      return row;
    })();
    if (!updated) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "installation not found", reasonCodes: [] });
    return contractOk(InstallationContracts.updateResponse, {
      id: updated.id,
      name: updated.name,
      edition: updated.edition,
      status: updated.disabled_at ? "disabled" : "active",
      updatedAt: updated.updated_at,
    }, requestId);
    }});
  });
}
