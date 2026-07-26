import { authorize } from "@/lib/auth";
import { contractOk, contractQuery } from "@/lib/contracts";
import { withWorkspace } from "@/lib/db";
import { wrapInEnvelope } from "@/lib/http";
import { ObservationContracts } from "@manifold/contracts";
import {
  decodeCursor,
  encodeCursor,
  parseLimit,
  parseObservationFilters,
  serializeObservation,
} from "./_query";
import { observationIngestLagSeconds, selectObservationRows } from "./_store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "observations:read");
    const url = new URL(req.url);
    contractQuery(url.searchParams, ObservationContracts.listQuery);
    const filters = parseObservationFilters(url.searchParams);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const limit = parseLimit(url.searchParams);

    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const [rows, ingestLagSeconds] = await Promise.all([
        selectObservationRows(sql, principal.workspaceId, filters, cursor, limit + 1),
        observationIngestLagSeconds(sql, principal.workspaceId),
      ]);
      return { rows, ingestLagSeconds };
    });

    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return contractOk(ObservationContracts.list,
      {
        data: page.map(serializeObservation),
        next_cursor:
          result.rows.length > limit && last
            ? encodeCursor({ createdAt: last.created_at, id: last.id })
            : null,
        ingest_lag_seconds: result.ingestLagSeconds,
      },
      requestId,
    );
  });
}
