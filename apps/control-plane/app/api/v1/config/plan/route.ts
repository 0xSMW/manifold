// POST /api/v1/config/plan (SPEC §10.3 config:read, §8.2 plan()).
//
// Builds the target snapshot for the installation, signs it, and diffs it against the active
// gateway_config_revision. Returns the plan (planHash, diff, tripwires). planHash is a pure
// function of (baseConfigHash, targetConfigHash, diff), and the target content hash is
// deterministic (build time excluded from the hash), so config/apply can rebuild and match.
import { authorize } from "@/lib/auth";
import { requireInstallation } from "@/lib/db";
import { buildSignedPlan } from "@/lib/snapshot";
import { handle, jsonBody, ok, requireString } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "config:read");
    const body = await jsonBody(req);
    const installationId = requireString(body, "installationId");
    await requireInstallation(principal.workspaceId, installationId);

    const plan = await buildSignedPlan(installationId);

    return ok(
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
  });
}
