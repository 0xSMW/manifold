import { authorize } from "@/lib/auth";
import { reconcileConfigOperation } from "@/lib/snapshot";
import { runPostCommitMutationGuard } from "@/lib/mutation-guard";
import { contractBody, contractOk } from "@/lib/contracts";
import { ConfigContracts } from "@manifold/contracts";
import {
  jsonBody,
  ManifoldError,
  ok,
  requireString,
  wrapInEnvelope,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "config:write");
    return runPostCommitMutationGuard({
      request: req,
      principal,
      requestId,
      // Reconciliation can call the configured accelerator; keep retries bounded.
      rateLimit: { limit: 10, windowMs: 60_000 },
      handler: async () => {
    if (
      principal.actorKind !== "member" ||
      !principal.member ||
      !["owner", "admin"].includes(principal.member.role)
    ) {
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "config reconciliation requires an admin or owner browser session",
        reasonCodes: [],
        remediation: "sign in as a workspace admin or owner",
      });
    }
    const { operationId } = await contractBody(req, ConfigContracts.reconcile);
    const result = await reconcileConfigOperation(principal.workspaceId, operationId);
    return contractOk(ConfigContracts.reconcileResponse, result, requestId);
      },
    });
  });
}
