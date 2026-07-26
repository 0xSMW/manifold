import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { DeploymentContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InstallationRow {
  id: string;
  disabled_at: string | null;
  applied_config_revision: string | null;
  last_seen_at: string | null;
  workload_identity: unknown;
}
interface RevisionRow {
  id: string;
  content_hash: string;
  snapshot: unknown;
  created_at: string;
}
interface ProviderRow {
  id: string;
  provider: string;
  label: string;
  status: string;
  last_validated_at: string | null;
}

function configuredCredentialIds(snapshot: unknown): Set<string> {
  const ids = new Set<string>();
  if (!snapshot || typeof snapshot !== "object") return ids;
  const routes = (snapshot as { routes?: unknown }).routes;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return ids;
  for (const route of Object.values(routes as Record<string, unknown>)) {
    if (!route || typeof route !== "object") continue;
    const targets = (route as { targets?: unknown }).targets;
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (!target || typeof target !== "object") continue;
      const credentialId = (target as { credentialId?: unknown }).credentialId;
      if (typeof credentialId === "string") ids.add(credentialId);
    }
  }
  return ids;
}

function snapshotMeta(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const meta = (snapshot as { meta?: unknown }).meta;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : null;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:read");
    const { id } = await ctx.params;
    const data = await withWorkspace(principal.workspaceId, async (sql) => {
      const installation = (await sql<InstallationRow[]>`
        SELECT id, disabled_at, applied_config_revision, last_seen_at, workload_identity
        FROM gateway_installation
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
        LIMIT 1`)[0];
      if (!installation) return null;
      const active = (await sql<RevisionRow[]>`
        SELECT id, content_hash, snapshot, created_at
        FROM gateway_config_revision
        WHERE installation_id = ${id} AND workspace_id = ${principal.workspaceId}
          AND status = 'active' LIMIT 1`)[0] ?? null;
      const providers = await sql<ProviderRow[]>`
        SELECT id, provider, label, status, last_validated_at
        FROM provider_credential
        WHERE workspace_id = ${principal.workspaceId} AND revoked_at IS NULL`;
      return { installation, active, providers };
    });
    if (!data) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "installation not found",
        reasonCodes: [],
      });
    }

    const now = Date.now();
    const lastSeenMs = data.installation.last_seen_at
      ? new Date(data.installation.last_seen_at).getTime()
      : Number.NaN;
    const heartbeatAgeSeconds = Number.isFinite(lastSeenMs)
      ? Math.max(0, Math.floor((now - lastSeenMs) / 1000))
      : null;
    const connected = !data.installation.disabled_at &&
      heartbeatAgeSeconds !== null && heartbeatAgeSeconds <= 600;
    const revisionsMatch = !!data.active &&
      data.installation.applied_config_revision === data.active.id;

    const credentialIds = configuredCredentialIds(data.active?.snapshot);
    const configuredProviders = data.providers.filter((provider) => credentialIds.has(provider.id));
    const missingCredentialIds = [...credentialIds].filter(
      (credentialId) => !data.providers.some((provider) => provider.id === credentialId),
    );
    const invalidProviders = configuredProviders
      .filter((provider) => provider.status !== "valid")
      .map((provider) => ({
        id: provider.id,
        provider: provider.provider,
        label: provider.label,
        status: provider.status,
        lastValidatedAt: provider.last_validated_at,
      }));
    const providersValid = invalidProviders.length === 0 && missingCredentialIds.length === 0;
    const meta = snapshotMeta(data.active?.snapshot);
    const workloadIdentity = data.installation.workload_identity;
    const workloadConfigured = !!workloadIdentity && typeof workloadIdentity === "object" && !Array.isArray(workloadIdentity) &&
      ["issuer", "jwksUrl", "audience", "subject"].every((field) => typeof (workloadIdentity as Record<string, unknown>)[field] === "string");
    const ready = connected && revisionsMatch && providersValid && (!workloadIdentity || workloadConfigured);

    return contractOk(DeploymentContracts.readinessResponse, {
      installationId: data.installation.id,
      ready,
      checks: {
        connectivity: {
          ok: connected,
          state: data.installation.disabled_at
            ? "disabled"
            : heartbeatAgeSeconds === null
              ? "never_seen"
              : connected
                ? "connected"
                : "stale",
          lastHeartbeatAt: data.installation.last_seen_at,
          heartbeatAgeSeconds,
          freshnessThresholdSeconds: 600,
          reportingAvailable: true,
        },
        snapshotFreshness: {
          ok: revisionsMatch,
          appliedRevision: data.installation.applied_config_revision,
          activeRevision: data.active?.id ?? null,
          state: !data.active
            ? "not_published"
            : revisionsMatch
              ? "current"
              : data.installation.applied_config_revision
                ? "revision_mismatch"
                : "not_reported",
        },
        providers: {
          ok: providersValid,
          state: credentialIds.size === 0
            ? "not_applicable"
            : providersValid
              ? "valid"
              : "invalid",
          configuredCredentialCount: credentialIds.size,
          invalid: invalidProviders,
          missingCredentialIds,
        },
        snapshotServing: {
          available: !!data.active,
          activeRevision: data.active?.id ?? null,
          contentHash: data.active?.content_hash ?? null,
          builtAt: typeof meta?.builtAt === "string" ? meta.builtAt : null,
          storedAt: data.active?.created_at ?? null,
          reportedServingActive: revisionsMatch,
        },
        clockSkew: {
          available: heartbeatAgeSeconds !== null,
          skewSeconds: null,
          reason: "heartbeat timestamps are accepted only within a bounded clock-skew window; exact skew is not retained",
        },
        installationAuthentication: {
          ok: workloadIdentity ? workloadConfigured : true,
          method: workloadIdentity ? "workload_identity" : "ed25519",
          state: workloadIdentity ? workloadConfigured ? "configured" : "invalid_configuration" : "configured",
          verifier: workloadIdentity ? "oidc_jwks" : "ed25519_request_signature",
        },
      },
    }, requestId);
  });
}
