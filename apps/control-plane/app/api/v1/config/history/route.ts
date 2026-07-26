import { authorize } from "@/lib/auth";
import { requireInstallation, withWorkspace } from "@/lib/db";
import {
  ManifoldError,
  ok,
  wrapInEnvelope,
} from "@/lib/http";
import { contractOk, contractQuery } from "@/lib/contracts";
import { ConfigContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:read");
    const { installationId } = contractQuery(new URL(req.url).searchParams, ConfigContracts.historyQuery);
    await requireInstallation(principal.workspaceId, installationId);
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const revisions = await sql`
        SELECT id, content_hash, parent_revision_id, status, created_by, created_at
        FROM gateway_config_revision
        WHERE workspace_id = ${principal.workspaceId}
          AND installation_id = ${installationId}
        ORDER BY created_at DESC`;
      const operations = await sql`
        SELECT id, operation_kind, revision_id, base_config_hash, target_config_hash,
               plan_hash, diff_json, outcome, serving_mode, accelerator_status,
               edge_config_version, tripwire_items, approved_by, error,
               reconciliation_attempts, last_reconcile_at, completed_at, created_by, created_at
        FROM config_operation
        WHERE workspace_id = ${principal.workspaceId}
          AND installation_id = ${installationId}
        ORDER BY created_at DESC`;
      return { revisions, operations };
    });
    return contractOk(ConfigContracts.historyResponse, { installationId, ...result }, requestId);
  });
}
