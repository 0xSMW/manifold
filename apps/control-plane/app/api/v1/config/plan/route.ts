// POST /api/v1/config/plan (SPEC §10.3 config:read, §8.2 plan()).
//
// Builds the target snapshot for the installation, signs it, and diffs it against the active
// gateway_config_revision. Returns the plan (planHash, diff, tripwires). planHash is a pure
// function of (baseConfigHash, targetConfigHash, diff), and the target content hash is
// deterministic (build time excluded from the hash), so config/apply can rebuild and match.
import { buildSnapshot, planApply } from "@manifold/config";
import { authorize } from "@/lib/auth";
import { db, withWorkspace } from "@/lib/db";
import { signSnapshot } from "@/lib/snapshot";
import { handle, jsonBody, ok, requireString, ManifoldError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function assertInstallation(workspaceId: string, installationId: string): Promise<void> {
  const rows = await withWorkspace(workspaceId, (sql) =>
    sql<{ id: string }[]>`
      SELECT id FROM gateway_installation
      WHERE id = ${installationId} AND workspace_id = ${workspaceId} LIMIT 1`,
  );
  if (!rows[0]) {
    throw new ManifoldError({
      status: 404,
      code: "NOT_FOUND",
      message: "installation not found",
      reasonCodes: [],
    });
  }
}

export async function POST(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "config:read");
    const body = await jsonBody(req);
    const installationId = requireString(body, "installationId");
    await assertInstallation(principal.workspaceId, installationId);

    const built = await buildSnapshot(db(), installationId);
    const signed = signSnapshot(built);
    const plan = await planApply(db(), installationId, signed);

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
