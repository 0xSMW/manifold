import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { runMutationGuard } from "@/lib/mutation-guard";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { genId } from "@/lib/ids";
import { contractBody, contractOk } from "@/lib/contracts";
import { PolicyEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "policies:approve");
    if (!principal.member)
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "policy approval requires a workspace member",
        reasonCodes: [],
      });
    const { id } = await context.params;
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async (sql) => {
        const body = await contractBody(req, PolicyEndpointContracts.approve);
        for (const key of Object.keys(body))
          if (key !== "revisionId" && key !== "reason")
            throw new ManifoldError({
              status: 422,
              code: "VALIDATION",
              message: `unknown field '${key}'`,
              reasonCodes: [],
            });
        if (typeof body.revisionId !== "string" || body.revisionId.length === 0)
          throw new ManifoldError({
            status: 422,
            code: "VALIDATION",
            message: "revisionId must be a non-empty string",
            reasonCodes: [],
          });
        if (
          body.reason !== undefined &&
          (typeof body.reason !== "string" || body.reason.length === 0)
        )
          throw new ManifoldError({
            status: 422,
            code: "VALIDATION",
            message: "reason must be a non-empty string when supplied",
            reasonCodes: [],
          });
        const revisionId = body.revisionId;
        const reason = body.reason as string | undefined;
        const result = await (async () => {
          // There is no uniqueness constraint for one member/revision approval in the existing
          // schema. Lock the immutable revision row to serialize the check/insert pair.
          const revision = await sql<
            { id: string }[]
          >`SELECT r.id FROM gateway_policy_revision r JOIN gateway_policy p ON p.id = r.policy_id AND p.workspace_id = ${principal.workspaceId} WHERE r.id = ${revisionId} AND r.policy_id = ${id} AND r.workspace_id = ${principal.workspaceId} LIMIT 1 FOR UPDATE OF r`;
          if (!revision[0]) return null;
          const existing = await sql<
            { id: string }[]
          >`SELECT id FROM policy_approval WHERE workspace_id = ${principal.workspaceId} AND policy_revision_id = ${revisionId} AND approved_by = ${principal.member!.id} LIMIT 1`;
          if (existing[0])
            return { approvalId: existing[0].id, created: false };
          const approvalId = genId("pap");
          await sql`INSERT INTO policy_approval (id, workspace_id, policy_revision_id, approved_by, reason) VALUES (${approvalId}, ${principal.workspaceId}, ${revisionId}, ${principal.member!.id}, ${reason ?? null})`;
          await audit(sql, principal, {
            action: "policy.approve",
            targetKind: "gateway_policy_revision",
            targetId: revisionId,
            requestId,
            detail: { policyId: id, reason: reason ?? null },
          });
          return { approvalId, created: true };
        })();
        if (!result)
          throw new ManifoldError({
            status: 404,
            code: "NOT_FOUND",
            message: "policy revision not found",
            reasonCodes: [],
          });
        if (!result.created)
          throw new ManifoldError({
            status: 409,
            code: "ALREADY_APPROVED",
            message: "this member already approved the policy revision",
            reasonCodes: [],
          });
        return contractOk(PolicyEndpointContracts.approveResponse,
          {
            policyId: id,
            revisionId,
            approvalId: result.approvalId,
            status: "approved",
          },
          requestId,
          201,
        );
      },
    });
  });
}
