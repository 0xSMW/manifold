import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { genId } from "@/lib/ids";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { DeploymentContracts } from "@manifold/contracts";
import {
  assertOnlyFields,
  canonicalHostname,
  enumField,
  hostnameTaken,
  isHostnameUniqueViolation,
  NETWORK_EXPOSURES,
  optionalObject,
  optionalStringList,
  PROFILE_MODES,
  TRUSTED_HOST_INVARIANT,
  validateAuthConfig,
  validateNetworkConfig,
} from "@/app/api/v1/deployments/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:write");
    requireMutationIdempotencyKey(req);
    const { id: installationId } = await ctx.params;
    const body = await contractBody(req.clone(), DeploymentContracts.profile);
    const rawBody = body as Record<string, unknown>;

    const hostname = canonicalHostname(body.hostname);
    const mode = enumField(rawBody, "mode", PROFILE_MODES);
    const networkExposure = enumField(rawBody, "networkExposure", NETWORK_EXPOSURES, "public");
    const authConfig = validateAuthConfig(mode, optionalObject(rawBody, "authConfig"));
    const networkConfig = validateNetworkConfig(
      networkExposure,
      optionalObject(rawBody, "networkConfig"),
    );
    const defaultRouteSet = optionalStringList(rawBody, "defaultRouteSet");
    const policyRevisionId = body.policyRevisionId;
    if (
      policyRevisionId !== undefined &&
      policyRevisionId !== null &&
      (typeof policyRevisionId !== "string" || policyRevisionId.length === 0)
    ) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "policyRevisionId must be a non-empty string or null",
        reasonCodes: [],
      });
    }

    const profileId = genId("prof");
    let result: { profileId: string } | { error: "installation" | "disabled" | "policy" };
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 20, windowMs: 60_000 }, handler: async (sql) => {
    try {
      result = await (async (sql) => {
        const installation = (await sql<{ id: string; disabled_at: string | null }[]>`
          SELECT id, disabled_at FROM gateway_installation
          WHERE id = ${installationId} AND workspace_id = ${principal.workspaceId}
          LIMIT 1`)[0];
        if (!installation) return { error: "installation" as const };
        if (installation.disabled_at) return { error: "disabled" as const };

        if (typeof policyRevisionId === "string") {
          const policy = await sql<{ id: string }[]>`
            SELECT id FROM gateway_policy_revision
            WHERE id = ${policyRevisionId} AND workspace_id = ${principal.workspaceId}
            LIMIT 1`;
          if (!policy[0]) return { error: "policy" as const };
        }

        // This check gives same-workspace callers a deterministic error. The DB's global unique
        // constraint remains authoritative for cross-workspace races and rows hidden by RLS.
        const existing = await sql<{ id: string }[]>`
          SELECT id FROM gateway_ingress_profile
          WHERE hostname = ${hostname} AND workspace_id = ${principal.workspaceId}
          LIMIT 1`;
        if (existing[0]) throw hostnameTaken(hostname);

        await sql`
          INSERT INTO gateway_ingress_profile
            (id, workspace_id, installation_id, hostname, mode, network_exposure,
             auth_config, network_config, policy_revision_id, default_route_set)
          VALUES
            (${profileId}, ${principal.workspaceId}, ${installationId}, ${hostname}, ${mode},
             ${networkExposure}, ${sql.json(authConfig as never)},
             ${networkConfig ? sql.json(networkConfig as never) : null},
             ${typeof policyRevisionId === "string" ? policyRevisionId : null},
             ${defaultRouteSet ? sql.json(defaultRouteSet as never) : null})`;

        await audit(sql, principal, {
          action: "profile.bind",
          targetKind: "gateway_ingress_profile",
          targetId: profileId,
          requestId,
          detail: { installationId, hostname, mode, networkExposure, status: "draft" },
        });
        return { profileId };
      })(sql);
    } catch (error) {
      if (error instanceof ManifoldError) throw error;
      if (isHostnameUniqueViolation(error)) throw hostnameTaken(hostname);
      throw error;
    }

    if ("error" in result) {
      if (result.error === "disabled") {
        throw new ManifoldError({
          status: 409,
          code: "VALIDATION",
          message: "cannot bind a profile to a disabled installation",
          reasonCodes: ["INSTALLATION_DISABLED"],
        });
      }
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: result.error === "policy" ? "policy revision not found" : "installation not found",
        reasonCodes: [],
      });
    }

    return contractOk(DeploymentContracts.profileResponse, {
      id: result.profileId,
      installationId,
      hostname,
      mode,
      networkExposure,
      authConfig,
      networkConfig,
      policyRevisionId: typeof policyRevisionId === "string" ? policyRevisionId : null,
      defaultRouteSet,
      status: "draft",
      published: false,
      bindingEffective: false,
      unpublishedChanges: 1,
      trustedHostInvariant: TRUSTED_HOST_INVARIANT,
    }, requestId, 201);
    }});
  });
}
