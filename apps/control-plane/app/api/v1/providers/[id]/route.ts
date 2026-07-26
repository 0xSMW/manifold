import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { ProvidersApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProviderRow {
  id: string;
  provider: string;
  label: string;
  base_url: string | null;
  deployment: unknown;
  allowed_hosts: unknown;
  status: string;
  last_validated_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OfferingRow {
  id: string;
  canonical_model_id: string;
  canonical_slug: string;
  display_name: string;
  provider_model_id: string;
  endpoint_kinds: unknown;
  capabilities: unknown;
  region: string | null;
  price_revision_id: string | null;
  price_fidelity: string | null;
  effective_from: string | null;
  input_per_mtok_microusd: string | null;
  output_per_mtok_microusd: string | null;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "providers:read");
    const { id } = await ctx.params;

    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const providers = await sql<ProviderRow[]>`
        SELECT id, provider, label, base_url, deployment, allowed_hosts, status,
               last_validated_at, revoked_at, created_at, updated_at
        FROM provider_credential
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
        LIMIT 1`;
      const provider = providers[0];
      if (!provider) return null;
      const offerings = await sql<OfferingRow[]>`
        SELECT o.id, o.canonical_model_id, c.canonical_slug, c.display_name,
               o.provider_model_id, o.endpoint_kinds, o.capabilities, o.region,
               p.id AS price_revision_id, p.fidelity AS price_fidelity, p.effective_from,
               p.input_per_mtok_microusd::text, p.output_per_mtok_microusd::text
        FROM provider_model_offering o
        JOIN canonical_model c ON c.id = o.canonical_model_id
        LEFT JOIN provider_price_revision p ON p.id = o.active_price_revision_id
        WHERE o.provider = ${provider.provider}
        ORDER BY c.display_name, o.provider_model_id`;
      return { provider, offerings };
    });
    if (!result) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "provider credential not found",
        reasonCodes: [],
      });
    }

    const provider = result.provider;
    return contractOk(ProvidersApi.detailResponse,
      {
        id: provider.id,
        provider: provider.provider,
        label: provider.label,
        baseUrl: provider.base_url,
        deployment: provider.deployment,
        allowedHosts: provider.allowed_hosts,
        status: provider.revoked_at ? "revoked" : provider.status,
        lastValidatedAt: provider.last_validated_at,
        revokedAt: provider.revoked_at,
        createdAt: provider.created_at,
        updatedAt: provider.updated_at,
        offerings: result.offerings.map((offering) => ({
          id: offering.id,
          canonicalModel: {
            id: offering.canonical_model_id,
            slug: offering.canonical_slug,
            displayName: offering.display_name,
          },
          providerModelId: offering.provider_model_id,
          endpointKinds: offering.endpoint_kinds,
          capabilities: offering.capabilities,
          region: offering.region,
          activePrice: offering.price_revision_id
            ? {
                id: offering.price_revision_id,
                fidelity: offering.price_fidelity,
                effectiveFrom: offering.effective_from,
                currency: "USD",
                unit: "per_mtok",
                inputPerMtokMicrousd: offering.input_per_mtok_microusd,
                outputPerMtokMicrousd: offering.output_per_mtok_microusd,
              }
            : null,
        })),
      },
      requestId,
    );
  });
}
