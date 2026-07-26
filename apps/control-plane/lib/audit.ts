// Append an audit_event row inside the same transaction as the mutation (SPEC §9, §6.12).
// audit_event is append-only (immutability trigger). Buffered/flush semantics from §9 are
// simplified here to a direct in-txn insert.
import type { Sql } from "@/lib/db";
import { genId } from "@/lib/ids";
import type { Principal } from "@/lib/auth";
import { createHash } from "node:crypto";

export interface AuditDraft {
  action: string;
  targetKind?: string;
  targetId?: string;
  requestId?: string;
  detail?: Record<string, unknown>;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Deterministic JSON: object insertion order must never affect a verification result. */
function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  // Audit detail is JSONB; reject non-JSON values rather than silently hashing a lossy coercion.
  throw new TypeError("audit detail must be JSON-serializable");
}

export interface AuditChainPayload {
  id: string;
  workspaceId: string;
  actorKind: string;
  actorId: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  requestRef: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
  chainSequence: string;
  prevChainHash: string | null;
}

/** Shared by writer and verifier. `prevChainHash` is hex to avoid bytea text representation drift. */
export function hashAuditChainPayload(payload: AuditChainPayload): Buffer {
  return createHash("sha256").update(stableJson(payload)).digest();
}

export async function audit(
  sql: Sql,
  principal: Principal,
  draft: AuditDraft,
): Promise<void> {
  const id = genId("aud");
  const detail = draft.detail ?? null;
  // Serialize chain appends per workspace. This lock has transaction lifetime and avoids two
  // concurrent writers observing the same predecessor; it does not cross tenant boundaries.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${principal.workspaceId}, 0))`;
  // Stamp after acquiring the chain lock. Stamping before it lets a waiter receive an earlier
  // timestamp than its predecessor, which makes the canonical created_at/id verification order
  // disagree with append order.
  const createdAt = new Date().toISOString();
  const previous = await sql<{ chain_hash: Buffer; chain_sequence_text: string }[]>`
    SELECT chain_hash, chain_sequence::text AS chain_sequence_text FROM audit_event
    WHERE workspace_id = ${principal.workspaceId} AND chain_version = 1
    ORDER BY chain_sequence DESC LIMIT 1`;
  const prevChainHash = previous[0]?.chain_hash ? Buffer.from(previous[0].chain_hash).toString("hex") : null;
  const chainSequence = String(BigInt(previous[0]?.chain_sequence_text ?? "0") + 1n);
  const chainHash = hashAuditChainPayload({
    id, workspaceId: principal.workspaceId, actorKind: principal.actorKind, actorId: principal.actorId,
    action: draft.action, targetKind: draft.targetKind ?? null, targetId: draft.targetId ?? null,
    beforeHash: null, afterHash: null, requestRef: draft.requestId ?? null, detail,
    createdAt, chainSequence, prevChainHash,
  });
  await sql`
    INSERT INTO audit_event
      (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id,
       request_ref, detail, chain_version, chain_sequence, prev_chain_hash, chain_hash, chain_sealed_at, created_at)
    VALUES
      (${id}, ${principal.workspaceId}, ${principal.actorKind}, ${principal.actorId},
       ${draft.action}, ${draft.targetKind ?? null}, ${draft.targetId ?? null},
       ${draft.requestId ?? null},
       ${detail ? sql.json(detail as never) : null}, 1, ${chainSequence}, ${prevChainHash ? Buffer.from(prevChainHash, "hex") : null},
       ${chainHash}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;
}
