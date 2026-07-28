// GET /api/v1/health (SPEC §10.3, §18.4). Honest liveness: actually attempts a DB `SELECT 1`
// and reports db: ok | unreachable (never a fabricated "ok"). Public (no auth) so external
// monitors and the Deployments panel can probe it.
import { rawSql } from "@/lib/db";
import { baseHeaders, newRequestId } from "@/lib/http";
import { HealthResponse, SCHEMA_VERSION } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_REVISION = /^[0-9a-f]{7,64}$/i;

/** Only Vercel-provided runtime metadata may become public release provenance. */
export function vercelDeploymentProvenance(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const deploymentId = env.VERCEL_DEPLOYMENT_ID?.trim() ?? "";
  const sourceRevision = env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  if (!DEPLOYMENT_ID.test(deploymentId) || !SOURCE_REVISION.test(sourceRevision)) return {};
  return {
    "x-manifold-deployment-id": deploymentId,
    "x-manifold-source-revision": sourceRevision.toLowerCase(),
  };
}

export async function GET(): Promise<Response> {
  // Public (no auth), so it does not run through `wrapInEnvelope`; but it still carries the kit's
  // correlation/schema headers (X-Request-Id, X-Manifold-Schema) like every other response.
  const requestId = newRequestId();
  let db: "ok" | "unreachable" = "unreachable";
  if (process.env.DATABASE_URL) {
    try {
      await rawSql()`SELECT 1`;
      db = "ok";
    } catch (err) {
      console.error("health: db probe failed:", err);
      db = "unreachable";
    }
  }

  const body = {
    status: db === "ok" ? ("ok" as const) : ("down" as const),
    schema: SCHEMA_VERSION,
    time: new Date().toISOString(),
    checks: {
      db,
      // Snapshot store liveness is not probed here (the DB is the source of truth, §8.2).
      snapshot_store: "skipped" as const,
    },
    ingest_lag_seconds: null,
    storage_tier: null,
  };

  const checked = HealthResponse.parse(body);
  return new Response(JSON.stringify(checked), {
    status: db === "ok" ? 200 : 503,
    headers: { ...baseHeaders(requestId), ...vercelDeploymentProvenance(), "content-type": "application/json" },
  });
}
