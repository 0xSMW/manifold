import { authorize } from "@/lib/auth";
import { contractOk, contractQuery } from "@/lib/contracts";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { ObservationContracts } from "@manifold/contracts";
import { parseObservationFilters } from "../_query";
import { selectLatencySummary } from "../_store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUMMARY_RANGE_MS = 30 * 24 * 60 * 60 * 1_000;

function requireOverviewRange(from: string, to: string): void {
  if (Date.parse(to) - Date.parse(from) > MAX_SUMMARY_RANGE_MS) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "latency summary supports ranges up to 30 days",
      reasonCodes: [],
      details: { issues: [{ path: "range", message: "latency summary supports ranges up to 30 days" }] },
    });
  }
}

/**
 * Return scalar percentile truth for the Overview. PostgreSQL performs the ordered-set
 * aggregate; no observation rows or unbounded trace page are materialized in the app.
 */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "observations:read");
    const params = new URL(req.url).searchParams;
    contractQuery(params, ObservationContracts.summaryQuery);
    const filters = parseObservationFilters(params);
    requireOverviewRange(filters.from, filters.to);

    const summary = await withWorkspace(principal.workspaceId, (sql) =>
      selectLatencySummary(sql, principal.workspaceId, filters.from, filters.to, filters.profile),
    );

    return contractOk(ObservationContracts.summary,
      {
        sample_count: summary.sampleCount,
        p50_ms: summary.p50Ms,
        p95_ms: summary.p95Ms,
      },
      requestId,
    );
  });
}
