import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
import { authorizeSettings } from "@/lib/settings/access";
import { audit } from "@/lib/audit";
import { genId } from "@/lib/ids";
import { runMutationGuard } from "@/lib/mutation-guard";
import { enforceRoleCeiling } from "@/lib/settings/crud";
import { generateAuthActionToken, hashAuthToken } from "@/lib/auth-secret";
import { invitationDeliveryIdempotencyKey, sendAuthEmail } from "@/lib/auth-email";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Row = { id: string; email: string; role: string; expires_at: string; accepted_at: string | null; revoked_at: string | null; created_at: string };
const view = (row: Row) => ({ id: row.id, email: row.email, role: row.role, status: row.revoked_at ? "revoked" : row.accepted_at ? "accepted" : new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "pending", expiresAt: row.expires_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at, createdAt: row.created_at });
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
    const delivery: { value: { email: string; token: string; id: string; expiresAt: string } | null } = { value: null };
    const response = await runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 10, windowMs: 60_000 }, handler: async (sql) => {
      contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery);
      const body = await contractBody(req, SettingsEndpointContracts.invitationCreate);
      enforceRoleCeiling(principal, body.role);
      const email = body.email.toLowerCase();
      const existing = (await sql<{ id: string; accepted_at: string | null }[]>`SELECT id, accepted_at FROM member WHERE workspace_id=${principal.workspaceId} AND email=${email} FOR UPDATE`)[0];
      if (existing?.accepted_at) throw new ManifoldError({ status: 409, code: "VALIDATION", message: "an invitation cannot be created for this email", reasonCodes: ["MEMBER_EMAIL_EXISTS"] });
      if (existing && (await sql<{ id: string }[]>`SELECT id FROM workspace_invitation WHERE member_id=${existing.id} AND workspace_id=${principal.workspaceId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`)[0]) throw new ManifoldError({ status: 409, code: "VALIDATION", message: "an active invitation already exists for this email", reasonCodes: ["INVITATION_EXISTS"] });
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
      await audit(sql, principal, { action: "invitation.create", targetKind: "workspace_invitation", targetId: invitationId, requestId, detail: { email, role: body.role } });
      delivery.value = { email, token, id: invitationId, expiresAt };
      return contractOk(SettingsEndpointContracts.invitationResponse, { data: view(row) }, requestId, 201);
    } });
    const pendingDelivery = delivery.value;
    if (pendingDelivery && response.ok) {
      try { await sendAuthEmail({ to: pendingDelivery.email, kind: "invitation", token: pendingDelivery.token, expiresAt: pendingDelivery.expiresAt }, { idempotencyKey: invitationDeliveryIdempotencyKey(pendingDelivery.id, pendingDelivery.token) }); }
      catch { throw new ManifoldError({ status: 500, code: "INTERNAL", message: "invitation delivery could not be completed", reasonCodes: ["INVITATION_DELIVERY_FAILED"], retryable: true }); }
    }
    return response;
  });
}
