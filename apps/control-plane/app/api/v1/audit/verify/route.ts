import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { hashAuditChainPayload } from "@/lib/audit";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { AuditEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  id: string; workspace_id: string; actor_kind: string; actor_id: string | null; action: string;
  target_kind: string | null; target_id: string | null; before_hash: string | null; after_hash: string | null;
  request_ref: string | null; detail: Record<string, unknown> | null; created_at: string;
  chain_sequence_text: string; prev_chain_hash: Buffer | null; chain_hash: Buffer; chain_version: number;
}

/** Verify every v1 commitment. Legacy records are reported separately and never treated as verified. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if ([...new URL(req.url).searchParams.keys()].length) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "audit verification does not accept query parameters", reasonCodes: [] });
    const principal = await authorize(req, "audit:read");
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const legacy = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM audit_event WHERE workspace_id = ${principal.workspaceId} AND chain_version IS NULL`;
      const rows = await sql<Row[]>`
        SELECT id, workspace_id, actor_kind, actor_id, action, target_kind, target_id, before_hash, after_hash,
               request_ref, detail, created_at, chain_sequence::text AS chain_sequence_text,
               prev_chain_hash, chain_hash, chain_version
        FROM audit_event WHERE workspace_id = ${principal.workspaceId} AND chain_version = 1
        ORDER BY chain_sequence ASC`;
      let previous: Buffer | null = null;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        if (BigInt(row.chain_sequence_text) !== BigInt(index + 1)) return { verified: false, checked: rows.length, legacy: Number(legacy[0]?.count ?? 0), firstFailure: { id: row.id, reason: "sequence_gap" } };
        const expectedPrevious = previous?.toString("hex") ?? null;
        const storedPrevious = row.prev_chain_hash ? Buffer.from(row.prev_chain_hash).toString("hex") : null;
        if (storedPrevious !== expectedPrevious) return { verified: false, checked: rows.length, legacy: Number(legacy[0]?.count ?? 0), firstFailure: { id: row.id, reason: "predecessor_mismatch" } };
        const expected = hashAuditChainPayload({
          id: row.id, workspaceId: row.workspace_id, actorKind: row.actor_kind, actorId: row.actor_id,
          action: row.action, targetKind: row.target_kind, targetId: row.target_id, beforeHash: row.before_hash,
          afterHash: row.after_hash, requestRef: row.request_ref, detail: row.detail,
          createdAt: new Date(row.created_at).toISOString(), chainSequence: row.chain_sequence_text, prevChainHash: storedPrevious,
        });
        if (!expected.equals(Buffer.from(row.chain_hash))) return { verified: false, checked: rows.length, legacy: Number(legacy[0]?.count ?? 0), firstFailure: { id: row.id, reason: "hash_mismatch" } };
        previous = Buffer.from(row.chain_hash);
      }
      return { verified: true, checked: rows.length, legacy: Number(legacy[0]?.count ?? 0), latestHash: previous?.toString("hex") ?? null };
    });
    return contractOk(AuditEndpointContracts.verify, { data: result, verification: { scope: "all_v1_workspace_events", legacyRecordsExcluded: result.legacy } }, requestId);
  });
}
