import { assertSessionMutationSecurity, authenticateSession, type Principal } from "@/lib/auth";

/** Personal account controls deliberately bypass workspace-admin scopes and roles. */
export async function authorizeAccountSession(req: Request): Promise<Principal> {
  const principal = await authenticateSession(req);
  if (!principal.member || !principal.sessionId) throw new Error("authenticated member session required");
  await assertSessionMutationSecurity(req, principal);
  return principal;
}
