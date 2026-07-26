import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { AuditEndpointContracts } from "@manifold/contracts";
import {
  encodeAuditCursor,
  parseAuditListQuery,
  selectAuditTimelineRows,
  serializeAuditTimelineRow,
} from "@/lib/audit-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/audit — workspace-scoped chronological audit and policy-decision timeline. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "audit:read");
    const query = parseAuditListQuery(req);
    const rows = await withWorkspace(principal.workspaceId, (sql) => selectAuditTimelineRows(sql, principal.workspaceId, query));
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return contractOk(AuditEndpointContracts.list, {
      data: page.map(serializeAuditTimelineRow),
      nextCursor: rows.length > query.limit && last
        ? encodeAuditCursor({ createdAt: last.created_at, kind: last.kind, id: last.id })
        : null,
      capabilities: {
        chainVerification: "available",
        destinations: "available",
        // audit_event is retained independently; the schema cannot represent a compacted event.
        compaction: "not_applicable",
      },
    }, requestId);
  });
}
