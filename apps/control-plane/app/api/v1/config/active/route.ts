// GET /api/v1/config/active?installationId=... (SPEC §10.3, §7.4 boot fallback).
//
// Returns the EXACT signed snapshot bytes of the active gateway_config_revision — this is the
// gateway's boot-fallback endpoint when the edge store is cold (§7.4). The DB is the source of
// truth (§8.2); we return `snapshot` verbatim so the signature (meta.signature over the content
// hash, §7.3) verifies against the pinned public key.
//
// Auth is the registered installation identity; operator config inspection remains on the
// separate plan/history endpoints. A bearer token cannot load a serving snapshot.
import { authenticateInstallation } from "@/lib/installation-auth";
import { withWorkspace } from "@/lib/db";
import { baseHeaders, wrapInEnvelope, ManifoldError } from "@/lib/http";
import { contractQuery } from "@/lib/contracts";
import { ActiveSnapshotWireBytes, ConfigContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const url = new URL(req.url);
    const { installationId } = contractQuery(url.searchParams, ConfigContracts.activeQuery);
    const principal = await authenticateInstallation(req, {
      path: "/api/v1/config/active",
      installationId,
    });

    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<{
        id: string;
        snapshot: unknown;
        accelerator_status: string | null;
        edge_config_version: string | null;
      }[]>`
        SELECT r.id, r.snapshot, o.accelerator_status, o.edge_config_version
        FROM gateway_config_revision r
        LEFT JOIN LATERAL (
          SELECT accelerator_status, edge_config_version
          FROM config_operation
          WHERE revision_id = r.id AND workspace_id = ${principal.workspaceId}
          ORDER BY created_at DESC LIMIT 1
        ) o ON true
        WHERE r.installation_id = ${installationId}
          AND r.workspace_id = ${principal.workspaceId}
          AND r.status = 'active'
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
    const wire = JSON.stringify(active.snapshot);
    const parsedWire = ActiveSnapshotWireBytes.safeParse(wire);
    if (!parsedWire.success) throw new ManifoldError({ status: 500, code: "INTERNAL", message: "active snapshot violates its signed byte contract", reasonCodes: [] });
    return new Response(parsedWire.data, {
      status: 200,
      headers: {
        ...baseHeaders(requestId),
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(parsedWire.data)),
        "x-manifold-serving-mode": "boot_fallback",
        "x-manifold-active-revision": active.id,
        "x-manifold-accelerator-status": active.accelerator_status ?? "not_configured",
        ...(active.edge_config_version
          ? { "x-manifold-edge-config-version": active.edge_config_version }
          : {}),
      },
    });
  });
}
