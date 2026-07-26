import { audit } from "@/lib/audit";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { runMutationGuard } from "@/lib/mutation-guard";
import { authorizeSettings } from "@/lib/settings/access";
import { enforceRoleCeiling, enforceTargetCeiling, notFound } from "@/lib/settings/crud";
import { memberStatus } from "@/lib/settings/human-auth";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) { return wrapInEnvelope(async (requestId) => { contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery); const principal = await authorizeSettings(req, "config:write"); const { id } = await ctx.params; return runMutationGuard({ request: req, principal, requestId, handler: async (sql) => { const body = await contractBody(req, SettingsEndpointContracts.memberUpdate); const current = (await sql<{ id: string; role: string; disabled_at: string | null; accepted_at: string | null; user_id: string | null }[]>`SELECT id, role, disabled_at, accepted_at, user_id FROM member WHERE id = ${id} AND workspace_id = ${principal.workspaceId} FOR UPDATE`)[0]; if (!current) throw notFound("member"); enforceTargetCeiling(principal, current.role); if (body.role !== undefined) enforceRoleCeiling(principal, body.role); const nextRole = body.role ?? current.role; const disabled = body.disabled ?? current.disabled_at !== null;
      if (id === principal.member!.id && (disabled || nextRole !== current.role)) throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "you cannot change your own membership role or status", reasonCodes: ["SELF_MEMBER_MANAGEMENT"] });
      // Lock all accepted owners before deciding. This serializes concurrent demote/disable requests.
      if (current.role === "owner" && current.accepted_at && !current.disabled_at && (disabled || nextRole !== "owner")) {
        const owners = await sql<{ id: string }[]>`SELECT id FROM member WHERE workspace_id = ${principal.workspaceId} AND role = 'owner' AND accepted_at IS NOT NULL AND disabled_at IS NULL FOR UPDATE`;
        if (owners.length <= 1) throw new ManifoldError({ status: 409, code: "VALIDATION", message: "the last active owner cannot be demoted or disabled", reasonCodes: ["LAST_ACTIVE_OWNER"] });
      }
      const row = (await sql<{ id: string; email: string; name: string | null; role: string; disabled_at: string | null; accepted_at: string | null; created_at: string }[]>`UPDATE member SET role = ${nextRole}, disabled_at = ${disabled ? new Date().toISOString() : null}, updated_at = now() WHERE id = ${id} AND workspace_id = ${principal.workspaceId} RETURNING id, email, name, role, disabled_at, accepted_at, created_at`)[0]!;
      if (disabled && !current.disabled_at) { await sql`UPDATE console_session SET revoked_at = COALESCE(revoked_at, now()) WHERE workspace_id = ${principal.workspaceId} AND member_id = ${id}`; await sql`UPDATE api_token SET revoked_at = COALESCE(revoked_at, now()) WHERE workspace_id = ${principal.workspaceId} AND (created_by = ${id} OR (${current.user_id}::text IS NOT NULL AND user_id = ${current.user_id}))`; }
      await audit(sql, principal, { action: "member.update", targetKind: "member", targetId: id, requestId, detail: { role: nextRole, disabled } }); return contractOk(SettingsEndpointContracts.memberResponse, { data: { id: row.id, email: row.email, name: row.name, role: row.role, status: memberStatus(row), createdAt: row.created_at } }, requestId); } }); }); }
