import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeSettings } from "@/lib/settings/access";
import { audit } from "@/lib/audit";
import { runMutationGuard } from "@/lib/mutation-guard";
import { generateAuthActionToken, hashAuthToken } from "@/lib/auth-secret";
import { invitationDeliveryIdempotencyKey, sendAuthEmail } from "@/lib/auth-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorizeSettings(req, "config:write");
    const { id } = await ctx.params;
    const delivery: { value: { email: string; token: string; expiresAt: string } | null } = { value: null };
    const response = await runMutationGuard({ request: req, principal, requestId, handler: async (sql) => {
      contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery);
      const token = generateAuthActionToken();
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const row = (await sql<{ email: string; expires_at: string }[]>`UPDATE workspace_invitation SET keyed_hash=${hashAuthToken(token)},expires_at=${expiresAt} WHERE id=${id} AND workspace_id=${principal.workspaceId} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email,expires_at`)[0];
      if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "pending invitation not found", reasonCodes: [] });
      delivery.value = { email: row.email, token, expiresAt: row.expires_at };
      await audit(sql, principal, { action: "invitation.resend", targetKind: "workspace_invitation", targetId: id, requestId });
      return contractOk(SettingsEndpointContracts.invitationResendResponse, { data: { id, status: "pending", resent: true, expiresAt: row.expires_at } }, requestId);
    } });
    const pendingDelivery = delivery.value;
    if (pendingDelivery && response.ok) {
      try { await sendAuthEmail({ to: pendingDelivery.email, kind: "invitation", token: pendingDelivery.token, expiresAt: pendingDelivery.expiresAt }, { idempotencyKey: invitationDeliveryIdempotencyKey(id, pendingDelivery.token) }); }
      catch { throw new ManifoldError({ status: 500, code: "INTERNAL", message: "invitation delivery could not be completed", reasonCodes: ["INVITATION_DELIVERY_FAILED"], retryable: true }); }
    }
    return response;
  });
}
