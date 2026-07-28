import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
test("human-auth settings routes retain secret, owner, revocation, and durable invitation delivery guards", async () => {
  const [members, invitation, token, service, panels, delivery] = await Promise.all([
    read("app/api/v1/settings/members/[id]/route.ts"), read("app/api/v1/settings/invitations/route.ts"),
    read("app/api/v1/settings/tokens/route.ts"), read("app/api/v1/settings/service-accounts/[id]/disable/route.ts"),
    read("components/settings/human-auth-panels.tsx"),
    read("lib/invitation-delivery.ts"),
  ]);
  assert.match(members, /FOR UPDATE/); assert.match(members, /LAST_ACTIVE_OWNER/); assert.match(members, /UPDATE console_session/);
  // Creation commits before provider delivery. The post-commit guard durably stores a successful
  // 201 or the provider failure, so a same-key retry replays the truthful outcome.
  assert.match(invitation, /runPostCommitMutationGuard/); assert.doesNotMatch(invitation, /runMutationGuard/);
  assert.match(invitation, /workspace_invitation_delivery/); assert.match(invitation, /encryptInvitationToken/);
  assert.match(delivery, /state='sent'/); assert.match(delivery, /state='failed'/);
  assert.match(delivery, /invitationDeliveryIdempotencyKey\(invitationId, token\)/);
  assert.match(delivery, /generation=\$\{delivery\.generation\}/); assert.match(delivery, /token_digest=\$\{delivery\.tokenDigest\}/);
  assert.match(invitation, /status: 503/); assert.match(invitation, /INVITATION_DELIVERY_FAILED/);
  assert.match(invitation, /details: \{ invitationId, retryPath:/); assert.match(invitation, /resend the invitation with POST/);
  assert.ok(invitation.indexOf("INSERT INTO workspace_invitation_delivery") < invitation.lastIndexOf("await deliverInvitation"), "the invitation outbox persists before delivery is attempted");
  // A fresh-key repeat reports the existing active invitation as an explicit resend recovery,
  // rather than returning the success representation or minting another live token.
  assert.match(invitation, /function existingInvitation/); assert.match(invitation, /status: 409/); assert.match(invitation, /reasonCodes: \["INVITATION_EXISTS"\]/);
  assert.match(invitation, /if \(!recovered\) throw existingInvitation\(activeInvitation\.id\)/);
  assert.match(invitation, /return \{ recovered: true as const, id: activeInvitation\.id/);
  const resend = await read("app/api/v1/settings/invitations/[id]/resend/route.ts");
  assert.doesNotMatch(resend, /expires_at>now\(\)/);
  assert.match(resend, /runPostCommitMutationGuard/); assert.doesNotMatch(resend, /runMutationGuard/);
  assert.match(resend, /workspace_invitation_delivery/); assert.match(resend, /state='pending'/);
  assert.match(resend, /generation=workspace_invitation_delivery\.generation\+1/);
  // Resend rotates the old capability and can recover a prior delivery failure without exposing it.
  assert.match(resend, /SET keyed_hash=\$\{hashAuthToken\(token\)\},expires_at=\$\{expiresAt\}/);
  assert.match(resend, /status: 503/); assert.match(resend, /retry with POST \/api\/v1\/settings\/invitations/);
  // The panel only shows delivery success on an OK response; failure and fresh-key duplicate
  // responses expose the targeted resend affordance from their non-secret invitation ID.
  assert.match(panels, /ControlPlaneApiError/); assert.match(panels, /INVITATION_DELIVERY_FAILED/);
  assert.match(panels, /INVITATION_EXISTS/); assert.match(panels, /Retry delivery/);
  assert.match(token, /validatedTokenScopes/); assert.match(token, /user_id/); assert.match(token, /sensitiveReplay/);
  assert.match(service, /UPDATE api_token SET revoked_at/);
});
