import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { runMutationGuard } from "@/lib/mutation-guard";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import {
  insertPolicyRevision,
  parsePolicyRevision,
} from "@/lib/policies/policy";
import { contractBody, contractOk } from "@/lib/contracts";
import { PolicyEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "policies:write");
    const { id } = await context.params;
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      handler: async (sql) => {
        const input = parsePolicyRevision(await contractBody(req, PolicyEndpointContracts.revision));
        const result = await (async () => {
          const policy = await sql<
            { id: string; archived_at: string | null }[]
          >`SELECT id, archived_at FROM gateway_policy WHERE id = ${id} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
          if (!policy[0]) return null;
          if (policy[0].archived_at)
            throw new ManifoldError({
              status: 422,
              code: "VALIDATION",
              message: "archived policies cannot receive revisions",
              reasonCodes: [],
            });
          const revision = await insertPolicyRevision(
            sql,
            principal.workspaceId,
            id,
            principal.member?.id ?? null,
            input,
          );
          await sql`UPDATE gateway_policy SET active_revision_id = ${revision.revisionId}, updated_at = now() WHERE id = ${id} AND workspace_id = ${principal.workspaceId}`;
          await audit(sql, principal, {
            action: "policy.revision.add",
            targetKind: "gateway_policy",
            targetId: id,
            requestId,
            detail: revision,
          });
          return revision;
        })();
        if (!result)
          throw new ManifoldError({
            status: 404,
            code: "NOT_FOUND",
            message: "policy not found",
            reasonCodes: [],
          });
        return contractOk(PolicyEndpointContracts.revisionResponse,
          {
            policyId: id,
            revisionId: result.revisionId,
            contentHash: result.contentHash,
            status: "staged",
            publishRequired: true,
          },
          requestId,
          201,
        );
      },
    });
  });
}
