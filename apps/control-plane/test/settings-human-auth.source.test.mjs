import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
test("human-auth settings routes retain secret, owner, and revocation guards", async () => {
  const [members, invitation, token, service] = await Promise.all([
    read("app/api/v1/settings/members/[id]/route.ts"), read("app/api/v1/settings/invitations/route.ts"),
    read("app/api/v1/settings/tokens/route.ts"), read("app/api/v1/settings/service-accounts/[id]/disable/route.ts"),
  ]);
  assert.match(members, /FOR UPDATE/); assert.match(members, /LAST_ACTIVE_OWNER/); assert.match(members, /UPDATE console_session/);
  assert.match(invitation, /response\.ok/); assert.match(invitation, /invitationDeliveryIdempotencyKey\(pendingDelivery\.id, pendingDelivery\.token\)/);
  const resend = await read("app/api/v1/settings/invitations/[id]/resend/route.ts");
  assert.doesNotMatch(resend, /expires_at>now\(\)/);
  assert.match(resend, /invitationDeliveryIdempotencyKey\(id, pendingDelivery\.token\)/);
  assert.match(token, /validatedTokenScopes/); assert.match(token, /user_id/); assert.match(token, /sensitiveReplay/);
  assert.match(service, /UPDATE api_token SET revoked_at/);
});
