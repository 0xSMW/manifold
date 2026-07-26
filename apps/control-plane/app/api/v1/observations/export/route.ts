import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth";
import { contractBody } from "@/lib/contracts";
import { withWorkspace } from "@/lib/db";
import { baseHeaders, ManifoldError, wrapInEnvelope } from "@/lib/http";
import { ObservationContracts } from "@manifold/contracts";
import {
  normalizedFilterAuditDetail,
  parseObservationFilters,
  serializeObservation,
  type ObservationCursor,
} from "../_query";
import { selectObservationRows } from "../_store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTER_FIELDS = new Set([
  "from",
  "start",
  "to",
  "end",
  "range",
  "profile",
  "profile_mode",
  "profileMode",
  "route",
  "route_id",
  "routeId",
  "model",
  "model_id",
  "modelId",
  "provider",
  "status",
  "app",
  "app_id",
  "appId",
  "action",
  "action_id",
  "actionId",
  "key",
  "key_id",
  "keyId",
  "cost_center",
  "costCenter",
  "cost_center_id",
  "costCenterId",
  "min_latency_ms",
  "minLatencyMs",
  "min_latency",
  "errors_only",
  "errorsOnly",
  "errors",
  "trace",
  "q",
  "trace_id",
  "traceId",
]);

function filterBody(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.filters;
  if (nested !== undefined) {
    if (
      nested === null ||
      typeof nested !== "object" ||
      Array.isArray(nested) ||
      Object.keys(body).some((key) => key !== "filters")
    ) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "filters must be the only top-level field and must be an object",
        reasonCodes: [],
        details: { issues: [{ path: "filters", message: "expected an object" }] },
      });
    }
    const filters = nested as Record<string, unknown>;
    const unknown = Object.keys(filters).filter((key) => !FILTER_FIELDS.has(key));
    if (unknown.length) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: `unknown export filter '${unknown[0]}'`,
        reasonCodes: [],
        details: { issues: [{ path: `filters.${unknown[0]}`, message: "unknown field" }] },
      });
    }
    return filters;
  }
  const unknown = Object.keys(body).filter((key) => !FILTER_FIELDS.has(key));
  if (unknown.length) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: `unknown export filter '${unknown[0]}'`,
      reasonCodes: [],
      details: { issues: [{ path: unknown[0], message: "unknown field" }] },
    });
  }
  return body;
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "observations:read");
    const filters = parseObservationFilters(filterBody(await contractBody(req, ObservationContracts.export)));

    await withWorkspace(principal.workspaceId, (sql) =>
      audit(sql, principal, {
        action: "observation.export",
        targetKind: "observation",
        requestId,
        detail: {
          format: "jsonl",
          filters: normalizedFilterAuditDetail(filters),
        },
      }),
    );

    const encoder = new TextEncoder();
    let cursor: ObservationCursor | null = null;
    let complete = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (complete) {
          controller.close();
          return;
        }
        try {
          const rows = await withWorkspace(principal.workspaceId, (sql) =>
            selectObservationRows(sql, principal.workspaceId, filters, cursor, 500),
          );
          for (const row of rows) {
            controller.enqueue(encoder.encode(`${JSON.stringify(ObservationContracts.jsonlLine.parse(serializeObservation(row)))}\n`));
          }
          const last = rows.at(-1);
          if (rows.length < 500 || !last) {
            complete = true;
            controller.close();
            return;
          }
          cursor = { createdAt: last.created_at, id: last.id };
        } catch (error) {
          console.error(`[${requestId}] observation export stream failed:`, error);
          complete = true;
          controller.error(new Error(`observation export failed; request id ${requestId}`));
        }
      },
      cancel() {
        complete = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...baseHeaders(requestId),
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="manifold-observations.jsonl"',
      },
    });
  });
}
