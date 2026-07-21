// POST /api/v1/keys/{id}/revoke (SPEC §10.3, keys:write, KeyService.revoke).
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { publishKeysOnly } from "@/lib/snapshot";
import { audit } from "@/lib/audit";
import { wrapInEnvelope, ok, ManifoldError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "keys:write");
    const { id } = await ctx.params;

    const row = await withWorkspace(principal.workspaceId, async (sql) => {
      const rows = await sql<{ id: string; profile_id: string }[]>`
        UPDATE virtual_key SET revoked_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
          AND revoked_at IS NULL
        RETURNING id, profile_id`;
      const updated = rows[0];
      if (updated) {
        // Resolve the key's installation so we can scope-publish the revocation.
        const prof = await sql<{ installation_id: string }[]>`
          SELECT installation_id FROM gateway_ingress_profile
          WHERE id = ${updated.profile_id} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
        await audit(sql, principal, {
          action: "key.revoke",
          targetKind: "virtual_key",
          targetId: id,
          requestId,
        });
        return { id: updated.id, installationId: prof[0]?.installation_id ?? null };
      }
      // No row matched revoked_at IS NULL: either the key does not exist in this workspace at all
      // (true 404), or — the retry case this fix closes — it was ALREADY revoked by an earlier call
      // whose DB update committed but whose scoped publishKeysOnly then failed (e.g. a concurrent
      // full apply raced it to CONFIG_PRECONDITION_FAILED, §8.2 H7). That earlier call's UPDATE runs
      // inside this same withWorkspace txn and COMMITS before publishKeysOnly is ever invoked, so a
      // retry's `WHERE revoked_at IS NULL` always matches zero rows once the key is revoked — the
      // route used to 404 here and NEVER re-invoke publishKeysOnly, permanently stranding the key in
      // the active snapshot with no way to re-drive the publish through this endpoint (review bug).
      // Distinguish "not found" from "already revoked" so the retry can still scope-publish: the DB
      // revoke is idempotent (WHERE revoked_at IS NULL just no-ops), but the publish step below is
      // NOT conditioned on having done the update ourselves — it must run every time so a failed
      // publish is always retryable via this same endpoint.
      const existing = await sql<{ id: string; profile_id: string }[]>`
        SELECT id, profile_id FROM virtual_key
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
      const found = existing[0];
      if (!found) return null;
      const prof = await sql<{ installation_id: string }[]>`
        SELECT installation_id FROM gateway_ingress_profile
        WHERE id = ${found.profile_id} AND workspace_id = ${principal.workspaceId} LIMIT 1`;
      return { id: found.id, installationId: prof[0]?.installation_id ?? null };
    });

    if (!row) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "active virtual key not found",
        reasonCodes: [],
      });
    }

    // Scope-publish the revocation into the active snapshot (§8.2 H7) so the snapshot-only gateway
    // stops accepting the key immediately instead of honoring it for the whole publish lag.
    //
    // publishKeysOnly returns `null` on a legitimate no-op (no active revision yet — nothing that
    // could have carried this key, or the rebuild was idempotent) and a ConfigOperation otherwise.
    // A non-null result whose `outcome !== "accepted"` (e.g. CONFIG_PRECONDITION_FAILED: a
    // concurrent full apply moved the active revision out from under this scoped publish) means
    // the revocation did NOT land — the active snapshot may still carry this key's hash. Pre-fix
    // this return value was discarded entirely, so the caller ALWAYS got `revoked:true` even when
    // the gateway was still honoring the key for the rest of the publish lag (review bug). Surface
    // a non-success instead of a false `revoked:true` so the caller knows to retry.
    //
    // This publish is driven unconditionally from `row` — including when the DB branch above found
    // the key ALREADY revoked (a retry). `readVirtualKeys` (packages/config db.ts) filters
    // `revoked_at IS NULL` straight from the table, not from any stale snapshot, so re-running
    // publishKeysOnly against an already-revoked key deterministically rebuilds a keys section that
    // still excludes it — the retry is genuinely idempotent and can keep re-driving the publish
    // through this same endpoint until it lands, closing the recovery gap where a 409 here used to
    // leave the key stranded in the active snapshot with no way back through this route.
    let published = true;
    if (row.installationId) {
      const publishResult = await publishKeysOnly(principal.workspaceId, row.installationId);
      if (publishResult && publishResult.outcome !== "accepted") {
        throw new ManifoldError({
          status: 409,
          code: "CONFIG_PRECONDITION_FAILED",
          message:
            "key revoked in the database, but the gateway snapshot publish did not land; retry the revoke",
          reasonCodes: publishResult.reasonCode ? [publishResult.reasonCode] : [],
          retryable: true,
        });
      }
      // null (no active revision / idempotent rebuild) or an accepted outcome both mean the key is
      // provably absent from whatever snapshot IS active — revoked:true is accurate here.
      published = publishResult !== null && publishResult.outcome === "accepted";
    }
    return ok({ id: row.id, revoked: true, published }, requestId);
  });
}
