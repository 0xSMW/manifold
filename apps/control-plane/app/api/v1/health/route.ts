// GET /api/v1/health (SPEC §10.3, §18.4). Honest liveness: actually attempts a DB `SELECT 1`
// and reports db: ok | unreachable (never a fabricated "ok"). Public (no auth) so external
// monitors and the Deployments panel can probe it.
import { rawSql } from "@/lib/db";
import { SCHEMA_VERSION } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
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

  return new Response(JSON.stringify(body), {
    status: db === "ok" ? 200 : 503,
    headers: {
      "content-type": "application/json",
      "X-Manifold-Schema": SCHEMA_VERSION,
      "cache-control": "no-store",
    },
  });
}
