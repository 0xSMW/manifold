// POST /api/v1/session/logout — revoke the current browser session and always clear its cookie.
import { assertSessionMutationSecurity, authenticateSession } from "@/lib/auth";
import { clearCsrfCookie, clearSessionCookie, revokeSession } from "@/lib/session";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { SessionLogoutResponse } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    // Logout is intentionally idempotent. An expired/revoked/unknown browser cookie
    // cannot be revoked again, but must still be removed from the browser.
    try {
      const principal = await authenticateSession(req);
      await assertSessionMutationSecurity(req, principal);
      await revokeSession(principal);
    } catch (err) {
      // Deliberately do not reveal whether the supplied cookie ever identified a session.
      // A database/operational error must still surface rather than claiming revocation succeeded.
      if (!(err instanceof ManifoldError) || err.reasonCodes.includes("CSRF_INVALID")) throw err;
    }
    const response = contractOk(SessionLogoutResponse, { loggedOut: true }, requestId);
    response.headers.append("set-cookie", clearSessionCookie());
    response.headers.append("set-cookie", clearCsrfCookie());
    return response;
  });
}
