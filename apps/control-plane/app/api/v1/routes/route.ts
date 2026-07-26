// GET/POST /api/v1/routes (SPEC §10.3, §6.5, RouteService).
//   GET  routes:read  — list this workspace's routes.
//   POST routes:write — create a route + its immutable first revision + a target, and set the
//     route's active_revision_id to that revision (one transaction).
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { audit } from "@/lib/audit";
import { genId } from "@/lib/ids";
import {
  wrapInEnvelope,
  jsonBody,
  ok,
  requireString,
  optionalString,
  ManifoldError,
} from "@/lib/http";
import { ENDPOINT_KINDS, insertRevision, parseRevision } from "./[id]/route-utils";
import { contractBody, contractOk } from "@/lib/contracts";
import { RoutesApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteListRow {
  id: string;
  public_name: string;
  endpoint_kind: string;
  active_revision_id: string | null;
  installation_id: string;
  disabled_at: string | null;
  target_count: number;
  healthy_target_count: number;
  created_at: string;
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "routes:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<RouteListRow[]>`
        SELECT r.id, r.public_name, r.endpoint_kind, r.active_revision_id, r.installation_id,
               r.disabled_at, r.created_at,
               COUNT(t.id)::int AS target_count,
               COUNT(t.id) FILTER (WHERE t.health_state = 'healthy')::int AS healthy_target_count
        FROM gateway_route r
        LEFT JOIN gateway_target t ON t.route_revision_id = r.active_revision_id
        WHERE r.workspace_id = ${principal.workspaceId} AND r.disabled_at IS NULL
        GROUP BY r.id
        ORDER BY r.created_at DESC`,
    );
    return contractOk(RoutesApi.listResponse,
      {
        data: rows.map((r) => ({
          id: r.id,
          publicName: r.public_name,
          endpointKind: r.endpoint_kind,
          installationId: r.installation_id,
          activeRevisionId: r.active_revision_id,
          status: r.active_revision_id ? "staged" : "draft",
          targetCount: r.target_count,
          healthyTargetCount: r.healthy_target_count,
          createdAt: r.created_at,
        })),
        nextCursor: null,
      },
      requestId,
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "routes:write");
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 20, windowMs: 60_000 }, handler: async (sql) => {
    const body = await contractBody(req, RoutesApi.createRequest);
    const allowedFields = new Set(["installationId", "publicName", "endpointKind", "target", "targets", "mode", "retryPolicy", "timeoutPolicy", "capturePolicy"]);
    for (const key of Object.keys(body)) {
      if (!allowedFields.has(key)) {
        throw new ManifoldError({ status: 422, code: "VALIDATION", message: `unknown field '${key}'`, reasonCodes: [], details: { issues: [{ path: key, message: "unknown field" }] } });
      }
    }
    const installationId = requireString(body, "installationId");
    const publicName = requireString(body, "publicName");
    const endpointKind = optionalString(body, "endpointKind") ?? "chat";
    if (!ENDPOINT_KINDS.has(endpointKind)) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: `endpointKind must be one of ${[...ENDPOINT_KINDS].join(", ")}`,
        reasonCodes: [],
      });
    }
    // Creation accepts the original single `target` form, but normalizes through the exact
    // revision contract so first and successor revisions cannot drift.
    const target = body.target;
    const revisionInput = parseRevision({
      mode: body.mode,
      targets: body.targets ?? (target === undefined ? undefined : [target]),
      retryPolicy: body.retryPolicy,
      timeoutPolicy: body.timeoutPolicy,
      capturePolicy: body.capturePolicy,
    });

    const result = await (async () => {
      // Validate installation is this workspace's.
      const inst = await sql<{ id: string }[]>`
        SELECT id FROM gateway_installation
        WHERE id = ${installationId} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
      if (!inst[0]) return { error: "installation" as const };

      // Duplicate route guard (route_name_uq: installation_id, endpoint_kind, public_name).
      const dup = await sql<{ id: string }[]>`
        SELECT id FROM gateway_route
        WHERE installation_id = ${installationId} AND endpoint_kind = ${endpointKind}
          AND public_name = ${publicName} LIMIT 1`;
      if (dup[0]) return { error: "duplicate" as const };

      const routeId = genId("rt");
      await sql`
        INSERT INTO gateway_route
          (id, workspace_id, installation_id, public_name, endpoint_kind)
        VALUES
          (${routeId}, ${principal.workspaceId}, ${installationId}, ${publicName},
           ${endpointKind})`;

      const revision = await insertRevision(sql, principal.workspaceId, routeId, principal.member?.id ?? null, revisionInput);

      await sql`
        UPDATE gateway_route SET active_revision_id = ${revision.revisionId}, updated_at = now()
        WHERE id = ${routeId}`;

      await audit(sql, principal, {
        action: "route.create",
        targetKind: "gateway_route",
        targetId: routeId,
        requestId,
        detail: { publicName, endpointKind, revisionId: revision.revisionId },
      });
      return { routeId, revisionId: revision.revisionId };
    })();

    if ("error" in result) {
      if (result.error === "duplicate") {
        throw new ManifoldError({
          status: 409,
          code: "DUPLICATE_ROUTE",
          message: `a ${endpointKind} route named '${publicName}' already exists on this installation`,
          reasonCodes: [],
        });
      }
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: `${result.error} not found`,
        reasonCodes: [],
      });
    }

    return contractOk(RoutesApi.createResponse,
      {
        id: result.routeId,
        status: "staged",
        revisionId: result.revisionId,
        unpublishedChanges: 1,
      },
      requestId,
      201,
    );
    }});
  });
}
