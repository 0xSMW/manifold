import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeSettings } from "@/lib/settings/access";
import { audit } from "@/lib/audit";
import { genId } from "@/lib/ids";
import { runPostCommitMutationGuard } from "@/lib/mutation-guard";
import { enforceRoleCeiling } from "@/lib/settings/crud";
import { generateAuthActionToken, hashAuthToken } from "@/lib/auth-secret";
import { deliverInvitation, encryptInvitationToken } from "@/lib/invitation-delivery";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Row = { id: string; email: string; role: string; expires_at: string; accepted_at: string | null; revoked_at: string | null; created_at: string };
const view = (row: Row) => ({ id: row.id, email: row.email, role: row.role, status: row.revoked_at ? "revoked" : row.accepted_at ? "accepted" : new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "pending", expiresAt: row.expires_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at, createdAt: row.created_at });

/**
 * The invitation and its capability have committed before the provider is called.  Do not make
 * callers guess whether it is safe to retry creation: identify the durable invitation and point
 * them at the operation which rotates and redelivers its capability.
 */
function deliveryFailure(invitationId: string): ManifoldError {
  return new ManifoldError({
    status: 503,
    code: "INTERNAL",
    message: "invitation was created but email delivery failed",
    reasonCodes: ["INVITATION_DELIVERY_FAILED"],
    remediation: `resend the invitation with POST /api/v1/settings/invitations/${invitationId}/resend`,
    retryable: true,
    details: { invitationId, retryPath: `/api/v1/settings/invitations/${invitationId}/resend` },
  });
}

function existingInvitation(invitationId: string): ManifoldError {
  return new ManifoldError({
    status: 409,
    code: "VALIDATION",
    message: "an active invitation already exists; resend it to retry delivery",
    reasonCodes: ["INVITATION_EXISTS"],
    remediation: `resend the invitation with POST /api/v1/settings/invitations/${invitationId}/resend`,
    details: { invitationId, retryPath: `/api/v1/settings/invitations/${invitationId}/resend` },
  });
}

export async function GET(req: Request) {
  return wrapInEnvelope(async (requestId) => {
    const { cursor, limit } = contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.pageQuery);
    const principal = await authorizeSettings(req, "config:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) => sql<Row[]>`SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at FROM workspace_invitation WHERE workspace_id=${principal.workspaceId} AND (${cursor}::text IS NULL OR id < ${cursor}) ORDER BY id DESC LIMIT ${limit + 1}`);
    const data = rows.slice(0, limit).map(view);
    return contractOk(SettingsEndpointContracts.invitationList, { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null }, requestId);
  });
}

export async function POST(req: Request) {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorizeSettings(req, "config:write");
    return runPostCommitMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 10, windowMs: 60_000 }, handler: async (recovered) => {
      // This transaction commits the invitation before the provider call. The post-commit guard
      // then durably records either the successful 201 or the actionable delivery failure, so a
      // same-key replay can never turn a failed delivery into a false success.
      const pendingDelivery = await withWorkspace(principal.workspaceId, async (sql) => {
        contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery);
        const body = await contractBody(req, SettingsEndpointContracts.invitationCreate);
        enforceRoleCeiling(principal, body.role);
        const email = body.email.toLowerCase();
        const existing = (await sql<{ id: string; accepted_at: string | null }[]>`SELECT id, accepted_at FROM member WHERE workspace_id=${principal.workspaceId} AND email=${email} FOR UPDATE`)[0];
        if (existing?.accepted_at) throw new ManifoldError({ status: 409, code: "VALIDATION", message: "an invitation cannot be created for this email", reasonCodes: ["MEMBER_EMAIL_EXISTS"] });
        const activeInvitation = existing && (await sql<Row[]>`SELECT id,email,role,expires_at,accepted_at,revoked_at,created_at FROM workspace_invitation WHERE member_id=${existing.id} AND workspace_id=${principal.workspaceId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`)[0];
        if (activeInvitation) {
          if (!recovered) throw existingInvitation(activeInvitation.id);
          return { recovered: true as const, id: activeInvitation.id, row: activeInvitation };
        }
        const memberId = existing?.id ?? genId("mem"); const invitationId = genId("inv"); const token = generateAuthActionToken();
        const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        if (existing) {
          await sql`UPDATE workspace_invitation SET revoked_at=COALESCE(revoked_at, now())
            WHERE member_id=${memberId} AND workspace_id=${principal.workspaceId} AND accepted_at IS NULL`;
          await sql`UPDATE member SET role=${body.role}, disabled_at=NULL, invited_at=now(), updated_at=now()
            WHERE id=${memberId} AND workspace_id=${principal.workspaceId}`;
        }
        else await sql`INSERT INTO member (id, workspace_id, email, role, invited_at, accepted_at) VALUES (${memberId}, ${principal.workspaceId}, ${email}, ${body.role}, now(), NULL)`;
        const row = (await sql<Row[]>`INSERT INTO workspace_invitation (id, workspace_id, member_id, email, role, invited_by, keyed_hash, expires_at) VALUES (${invitationId}, ${principal.workspaceId}, ${memberId}, ${email}, ${body.role}, ${principal.member!.id}, ${hashAuthToken(token)}, ${expiresAt}) RETURNING id,email,role,expires_at,accepted_at,revoked_at,created_at`)[0]!;
        const encrypted = encryptInvitationToken(token);
        await sql`INSERT INTO workspace_invitation_delivery (invitation_id,workspace_id,state,token_digest,token_ciphertext,token_iv,token_tag) VALUES (${invitationId},${principal.workspaceId},'pending',${hashAuthToken(token)},${encrypted.tokenCiphertext},${encrypted.tokenIv},${encrypted.tokenTag})`;
        await audit(sql, principal, { action: "invitation.create", targetKind: "workspace_invitation", targetId: invitationId, requestId, detail: { email, role: body.role } });
        return { recovered: false as const, id: invitationId, row };
      });
      const outcome = await deliverInvitation(principal.workspaceId, pendingDelivery.id);
      if (outcome !== "sent") throw deliveryFailure(pendingDelivery.id);
      return contractOk(SettingsEndpointContracts.invitationResponse, { data: view(pendingDelivery.row) }, requestId, 201);
    } });
  });
}
