// GET/POST /api/v1/config/plan (SPEC §10.3 config:read, §8.2 plan()).
//
// Builds the target snapshot for the installation, signs it, and diffs it against the active
// gateway_config_revision. Returns the plan (planHash, diff, tripwires). planHash is a pure
// function of (baseConfigHash, targetConfigHash, diff), and the target content hash is
// deterministic (build time excluded from the hash), so config/apply can rebuild and match.
import { authorize } from "@/lib/auth";
import { requireInstallation } from "@/lib/db";
import { buildSignedPlan } from "@/lib/snapshot";
import { wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { ConfigContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function planResponse(req: Request, installationId: string, requestId: string): Promise<Response> {
  const principal = await authorize(req, "config:read");
  await requireInstallation(principal.workspaceId, installationId);

  const plan = await buildSignedPlan(principal.workspaceId, installationId);

  return contractOk(ConfigContracts.planResponse,
    {
      installationId,
      planHash: plan.planHash,
      baseConfigHash: plan.baseConfigHash,
      targetConfigHash: plan.targetConfigHash,
      diff: plan.diffJson,
      tripwireItems: plan.tripwireItems,
      noop: plan.noop,
    },
    requestId,
  );
}

/** Documented read-only wire contract for CLI and external control-plane clients. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const query = contractQuery(new URL(req.url).searchParams, ConfigContracts.planQuery);
    return planResponse(req, query.installationId, requestId);
  });
}

/** Backward-compatible body form used by the current console. It remains read-only. */
export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const body = await contractBody(req, ConfigContracts.plan);
    return planResponse(req, body.installationId, requestId);
  });
}
