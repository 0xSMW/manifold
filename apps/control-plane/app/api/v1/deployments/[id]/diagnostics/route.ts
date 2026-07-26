import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk, contractQuery } from "@/lib/contracts";
import { DeploymentContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OperationRow {
  id: string;
  base_config_hash: string | null;
  target_config_hash: string | null;
  plan_hash: string | null;
  outcome: string;
  edge_config_version: string | null;
  tripwire_items: unknown;
  error: unknown;
  created_at: string;
}

interface SyntheticAuditRow {
  id: string;
  detail: unknown;
  created_at: string;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:read");
    const { id } = await ctx.params;
    const { limit } = contractQuery(new URL(req.url).searchParams, DeploymentContracts.diagnosticsQuery);

    const data = await withWorkspace(principal.workspaceId, async (sql) => {
      const installation = (await sql<{
        id: string;
        last_seen_at: string | null;
        applied_config_revision: string | null;
        disabled_at: string | null;
      }[]>`
        SELECT id, last_seen_at, applied_config_revision, disabled_at
        FROM gateway_installation
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
        LIMIT 1`)[0];
      if (!installation) return null;
      const operations = await sql<OperationRow[]>`
        SELECT id, base_config_hash, target_config_hash, plan_hash, outcome,
               edge_config_version, tripwire_items, error, created_at
        FROM config_operation
        WHERE installation_id = ${id} AND workspace_id = ${principal.workspaceId}
        ORDER BY created_at DESC LIMIT ${limit}`;
      const synthetic = (await sql<SyntheticAuditRow[]>`
        SELECT id, detail, created_at FROM audit_event
        WHERE workspace_id = ${principal.workspaceId} AND action = 'route.synthetic_test'
          AND detail->>'installationId' = ${id}
        ORDER BY created_at DESC LIMIT 1`)[0] ?? null;
      return { installation, operations, synthetic };
    });
    if (!data) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "installation not found",
        reasonCodes: [],
      });
    }

    return contractOk(DeploymentContracts.diagnosticsResponse, {
      installationId: data.installation.id,
      lastHeartbeat: {
        observedAt: data.installation.last_seen_at,
        appliedConfigRevision: data.installation.applied_config_revision,
        installationStatus: data.installation.disabled_at ? "disabled" : "active",
        reportingAvailable: true,
      },
      recentConfigOperations: data.operations.map((operation) => ({
        id: operation.id,
        outcome: operation.outcome,
        baseConfigHash: operation.base_config_hash,
        targetConfigHash: operation.target_config_hash,
        planHash: operation.plan_hash,
        edgeConfigVersion: operation.edge_config_version,
        tripwireItems: operation.tripwire_items,
        error: operation.error,
        createdAt: operation.created_at,
      })),
      syntheticTest: {
        available: Boolean(process.env.MANIFOLD_GATEWAY_DIAGNOSTICS_URL && process.env.MANIFOLD_GATEWAY_DIAGNOSTICS_TOKEN),
        lastResult: data.synthetic ? { id: data.synthetic.id, createdAt: data.synthetic.created_at, detail: data.synthetic.detail } : null,
        reason: process.env.MANIFOLD_GATEWAY_DIAGNOSTICS_URL && process.env.MANIFOLD_GATEWAY_DIAGNOSTICS_TOKEN
          ? "Run a route test against a published profile to create a trace visible in Logs."
          : "Set MANIFOLD_GATEWAY_DIAGNOSTICS_URL and MANIFOLD_GATEWAY_DIAGNOSTICS_TOKEN to enable authenticated route diagnostics.",
      },
    }, requestId);
  });
}
