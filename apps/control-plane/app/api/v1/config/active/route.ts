// GET /api/v1/config/active?installationId=... (SPEC §10.3, §7.4 boot fallback).
//
// Returns the EXACT signed snapshot bytes of the active gateway_config_revision — this is the
// gateway's boot-fallback endpoint when the edge store is cold (§7.4). The DB is the source of
// truth (§8.2); we return `snapshot` verbatim so the signature (meta.signature over the content
// hash, §7.3) verifies against the pinned public key.
//
// Auth: §10.3 specifies installation auth; for control-plane usability we accept a bearer
// api_token with config:read and derive the workspace from it (the installation must belong to
// that workspace).
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { handle, ManifoldError } from "@/lib/http";
import { SCHEMA_VERSION } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "config:read");
    const url = new URL(req.url);
    const installationId = url.searchParams.get("installationId");
    if (!installationId) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "installationId query parameter is required",
        reasonCodes: [],
      });
    }

    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<{ snapshot: unknown }[]>`
        SELECT snapshot FROM gateway_config_revision
        WHERE installation_id = ${installationId}
          AND workspace_id = ${principal.workspaceId}
          AND status = 'active'
        LIMIT 1`,
    );

    const active = rows[0];
    if (!active) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "no active config revision for installation",
        reasonCodes: [],
      });
    }

    // Return the signed snapshot verbatim (the exact bytes a loader verifies, §7.4).
    return new Response(JSON.stringify(active.snapshot), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "X-Request-Id": requestId,
        "X-Manifold-Schema": SCHEMA_VERSION,
        "cache-control": "no-store",
      },
    });
  });
}
