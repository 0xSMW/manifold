import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { genId } from "@/lib/ids";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { PolicyEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string;
  active_revision_id: string | null;
  created_at: string;
  updated_at: string;
  revision_count: number;
};

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "policies:read");
    const url = new URL(req.url);
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 200)
      : 50;
    const cursor = url.searchParams.get("cursor");
    const rows = await withWorkspace(
      principal.workspaceId,
      (sql) => sql<Row[]>`
      SELECT p.id, p.name, p.active_revision_id, p.created_at, p.updated_at, COUNT(r.id)::int AS revision_count
      FROM gateway_policy p LEFT JOIN gateway_policy_revision r ON r.policy_id = p.id AND r.workspace_id = ${principal.workspaceId}
      WHERE p.workspace_id = ${principal.workspaceId} AND p.archived_at IS NULL AND (${cursor}::text IS NULL OR p.id < ${cursor})
      GROUP BY p.id ORDER BY p.id DESC LIMIT ${limit + 1}`,
    );
    const data = rows
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        name: row.name,
        activeRevisionId: row.active_revision_id,
        revisionCount: row.revision_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    return contractOk(PolicyEndpointContracts.list,
      {
        data,
        nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null,
      },
      requestId,
    );
  });
}

/** Create the policy container. Its first immutable revision is authored in the editor. */
export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "policies:write");
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      handler: async (sql) => {
        const body = await contractBody(req, PolicyEndpointContracts.create);
        if (Object.keys(body).some((key) => key !== "name")) {
          throw new ManifoldError({
            status: 422,
            code: "VALIDATION",
            message: "only 'name' is allowed",
            reasonCodes: [],
            details: { issues: [{ path: "body", message: "unknown field" }] },
          });
        }
        if (typeof body.name !== "string") {
          throw new ManifoldError({
            status: 422,
            code: "VALIDATION",
            message: "name is required",
            reasonCodes: [],
            details: {
              issues: [{ path: "name", message: "required non-empty string" }],
            },
          });
        }
        const name = body.name.trim();
        if (!name || name.length > 120) {
          throw new ManifoldError({
            status: 422,
            code: "VALIDATION",
            message: "name must be between 1 and 120 characters",
            reasonCodes: [],
            details: { issues: [{ path: "name", message: "invalid length" }] },
          });
        }
        const result = await (async () => {
          const existing = (
            await sql<
              { id: string }[]
            >`SELECT id FROM gateway_policy WHERE workspace_id = ${principal.workspaceId} AND name = ${name} LIMIT 1`
          )[0];
          if (existing) return { existing: existing.id };
          const id = genId("pol");
          await sql`INSERT INTO gateway_policy (id, workspace_id, name) VALUES (${id}, ${principal.workspaceId}, ${name})`;
          await audit(sql, principal, {
            action: "policy.create",
            targetKind: "gateway_policy",
            targetId: id,
            requestId,
            detail: { name, staged: true },
          });
          return { id };
        })();
        if ("existing" in result) {
          throw new ManifoldError({
            status: 409,
            code: "VALIDATION",
            message: "a policy with this name already exists",
            reasonCodes: [],
            details: { policyId: result.existing },
          });
        }
        return contractOk(PolicyEndpointContracts.createResponse,
          { id: result.id, name, status: "draft", publishRequired: true },
          requestId,
          201,
        );
      },
    });
  });
}
