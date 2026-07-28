import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { withWorkspace } from "@/lib/db";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeSettings } from "@/lib/settings/access";
import { audit } from "@/lib/audit";
import { runPostCommitMutationGuard } from "@/lib/mutation-guard";
import { generateAuthActionToken, hashAuthToken } from "@/lib/auth-secret";
import { deliverInvitation, encryptInvitationToken } from "@/lib/invitation-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function deliveryFailure(invitationId: string): ManifoldError {
  return new ManifoldError({
    status: 503,
    code: "INTERNAL",
    message: "invitation was updated but email delivery failed",
    reasonCodes: ["INVITATION_DELIVERY_FAILED"],
    remediation: `retry with POST /api/v1/settings/invitations/${invitationId}/resend`,
    retryable: true,
    details: { invitationId, retryPath: `/api/v1/settings/invitations/${invitationId}/resend` },
  });
}


export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorizeSettings(req, "config:write");
    const { id } = await ctx.params;
    return runPostCommitMutationGuard({ request: req, principal, requestId, handler: async (recovered) => {
      const pendingDelivery = await withWorkspace(principal.workspaceId, async (sql) => {
        contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery);
        if (recovered) {
          const existing = (await sql<{ expires_at: string }[]>`SELECT i.expires_at FROM workspace_invitation_delivery d JOIN workspace_invitation i ON i.id=d.invitation_id WHERE d.invitation_id=${id} AND d.workspace_id=${principal.workspaceId} FOR UPDATE`)[0];
          if (existing) return { expiresAt: existing.expires_at };
        }
        const token = generateAuthActionToken();
        const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        const row = (await sql<{ email: string; expires_at: string }[]>`UPDATE workspace_invitation SET keyed_hash=${hashAuthToken(token)},expires_at=${expiresAt} WHERE id=${id} AND workspace_id=${principal.workspaceId} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email,expires_at`)[0];
        if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "pending invitation not found", reasonCodes: [] });
        const encrypted = encryptInvitationToken(token);
        await sql`INSERT INTO workspace_invitation_delivery (invitation_id,workspace_id,state,generation,token_digest,token_ciphertext,token_iv,token_tag,sent_at,failed_at,updated_at) VALUES (${id},${principal.workspaceId},'pending',1,${hashAuthToken(token)},${encrypted.tokenCiphertext},${encrypted.tokenIv},${encrypted.tokenTag},NULL,NULL,now()) ON CONFLICT (invitation_id) DO UPDATE SET state='pending',generation=workspace_invitation_delivery.generation+1,token_digest=EXCLUDED.token_digest,token_ciphertext=EXCLUDED.token_ciphertext,token_iv=EXCLUDED.token_iv,token_tag=EXCLUDED.token_tag,sent_at=NULL,failed_at=NULL,updated_at=now()`;
        await audit(sql, principal, { action: "invitation.resend", targetKind: "workspace_invitation", targetId: id, requestId });
        return { expiresAt: row.expires_at };
      });
      const outcome = await deliverInvitation(principal.workspaceId, id);
      if (outcome !== "sent") throw deliveryFailure(id);
      return contractOk(SettingsEndpointContracts.invitationResendResponse, { data: { id, status: "pending", resent: true, expiresAt: pendingDelivery.expiresAt } }, requestId);
    } });
  });
}
