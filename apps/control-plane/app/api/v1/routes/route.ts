// GET/POST /api/v1/routes (SPEC §10.3, §6.5, RouteService).
//   GET  routes:read  — list this workspace's routes.
//   POST routes:write — create a route + its immutable first revision + a target, and set the
//     route's active_revision_id to that revision (one transaction).
import { sha256Canonical } from "@manifold/config";
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { audit } from "@/lib/audit";
import { genId } from "@/lib/ids";
import {
  handle,
  jsonBody,
  ok,
  requireString,
  optionalString,
  optionalNumber,
  ManifoldError,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT_KINDS = new Set(["chat", "responses", "embeddings"]);

interface RouteListRow {
  id: string;
  public_name: string;
  endpoint_kind: string;
  active_revision_id: string | null;
  created_at: string;
}

export async function GET(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "routes:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<RouteListRow[]>`
        SELECT id, public_name, endpoint_kind, active_revision_id, created_at
        FROM gateway_route
        WHERE workspace_id = ${principal.workspaceId} AND disabled_at IS NULL
        ORDER BY created_at DESC`,
    );
    return ok(
      {
        data: rows.map((r) => ({
          id: r.id,
          publicName: r.public_name,
          endpointKind: r.endpoint_kind,
          activeRevisionId: r.active_revision_id,
          status: r.active_revision_id ? "active" : "draft",
          createdAt: r.created_at,
        })),
        next_cursor: null,
      },
      requestId,
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "routes:write");
    const body = await jsonBody(req);
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
    const target = (body.target ?? {}) as Record<string, unknown>;
    const providerCredentialId = requireString(target, "providerCredentialId");
    const offeringId = requireString(target, "offeringId");
    const mode = body.mode === "weighted" ? "weighted" : "ordered";
    const weight = optionalNumber(target, "weight", 1);
    const priority = optionalNumber(target, "priority", 0);
    const targetBaseUrl = optionalString(target, "baseUrl");
    const region = optionalString(target, "region");

    const retryPolicy = { attempts: 1, backoffMs: 0 };
    const timeoutPolicy = { overall_ms: 60000 };

    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      // Validate installation is this workspace's.
      const inst = await sql<{ id: string }[]>`
        SELECT id FROM gateway_installation
        WHERE id = ${installationId} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
      if (!inst[0]) return { error: "installation" as const };

      // Validate credential is this workspace's.
      const cred = await sql<{ id: string }[]>`
        SELECT id FROM provider_credential
        WHERE id = ${providerCredentialId} AND workspace_id = ${principal.workspaceId}
        LIMIT 1`;
      if (!cred[0]) return { error: "credential" as const };

      // Offering is global reference data (§6.4). Fetch adapter_revision for the target.
      const off = await sql<{ id: string; adapter_revision: string }[]>`
        SELECT id, adapter_revision FROM provider_model_offering
        WHERE id = ${offeringId} LIMIT 1`;
      if (!off[0]) return { error: "offering" as const };
      const adapterRevision = off[0].adapter_revision;

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

      const revisionId = genId("rev");
      const contentHash = sha256Canonical({
        routeId,
        mode,
        retryPolicy,
        timeoutPolicy,
        targets: [{ providerCredentialId, offeringId, adapterRevision, weight, priority }],
      });
      await sql`
        INSERT INTO gateway_route_revision
          (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash)
        VALUES
          (${revisionId}, ${principal.workspaceId}, ${routeId}, ${mode},
           ${sql.json(retryPolicy as never)}, ${sql.json(timeoutPolicy as never)},
           ${contentHash})`;

      const targetId = genId("tgt");
      await sql`
        INSERT INTO gateway_target
          (id, workspace_id, route_revision_id, provider_credential_id, offering_id,
           adapter_revision, base_url, region, weight, priority)
        VALUES
          (${targetId}, ${principal.workspaceId}, ${revisionId}, ${providerCredentialId},
           ${offeringId}, ${adapterRevision}, ${targetBaseUrl}, ${region}, ${weight},
           ${priority})`;

      await sql`
        UPDATE gateway_route SET active_revision_id = ${revisionId}, updated_at = now()
        WHERE id = ${routeId}`;

      await audit(sql, principal, {
        action: "route.create",
        targetKind: "gateway_route",
        targetId: routeId,
        requestId,
        detail: { publicName, endpointKind, revisionId },
      });
      return { routeId, revisionId };
    });

    if ("error" in result) {
      if (result.error === "duplicate") {
        throw new ManifoldError({
          status: 409,
          code: "DUPLICATE_ROUTE",
          message: `a ${endpointKind} route named '${publicName}' already exists on this installation`,
          reasonCodes: [],
        });
      }
      if (result.error === "offering") {
        throw new ManifoldError({
          status: 404,
          code: "OFFERING_NOT_FOUND",
          message: "offering not found",
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

    return ok(
      {
        id: result.routeId,
        status: "active",
        revisionId: result.revisionId,
        unpublishedChanges: 1,
      },
      requestId,
      201,
    );
  });
}
