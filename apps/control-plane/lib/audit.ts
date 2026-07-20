// Append an audit_event row inside the same transaction as the mutation (SPEC §9, §6.12).
// audit_event is append-only (immutability trigger). Buffered/flush semantics from §9 are
// simplified here to a direct in-txn insert.
import type { Sql } from "@/lib/db";
import { genId } from "@/lib/ids";
import type { Principal } from "@/lib/auth";

export interface AuditDraft {
  action: string;
  targetKind?: string;
  targetId?: string;
  requestId?: string;
  detail?: Record<string, unknown>;
}

export async function audit(
  sql: Sql,
  principal: Principal,
  draft: AuditDraft,
): Promise<void> {
  await sql`
    INSERT INTO audit_event
      (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id,
       request_ref, detail, created_at)
    VALUES
      (${genId("aud")}, ${principal.workspaceId}, 'api_token', ${principal.tokenId},
       ${draft.action}, ${draft.targetKind ?? null}, ${draft.targetId ?? null},
       ${draft.requestId ?? null},
       ${draft.detail ? sql.json(draft.detail as never) : null}, now())`;
}
