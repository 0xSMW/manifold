import { NextResponse } from "next/server";

// SPEC §18.5 — liveness for the Deployments diagnostics panel and external monitors.
// Skeleton: checks are reported "skipped" until wired (honest, not fabricated "ok").
export const dynamic = "force-dynamic";

const SCHEMA_VERSION = "manifold.v1";

export async function GET() {
  const body = {
    status: "ok" as const,
    schema: SCHEMA_VERSION,
    time: new Date().toISOString(),
    checks: {
      // Not yet actually probed — report skipped rather than claim health we didn't verify.
      db: process.env.DATABASE_URL ? ("skipped" as const) : ("skipped" as const),
      snapshot_store: process.env.EDGE_CONFIG
        ? ("skipped" as const)
        : ("skipped" as const),
    },
    ingest_lag_seconds: null,
    storage_tier: null,
    note: "skeleton: health checks not yet wired to Neon/Edge Config",
  };
  return NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
  });
}
