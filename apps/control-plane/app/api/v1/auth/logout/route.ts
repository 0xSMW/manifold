// POST /api/v1/auth/logout — identity-session logout. Invalid/expired cookies are idempotent.
import { assertSessionMutationSecurity, authenticateSession } from "@/lib/auth";
import { clearCsrfCookie, clearSessionCookie, revokeSession } from "@/lib/session";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { HumanAuthContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    try {
      const principal = await authenticateSession(req);
      await assertSessionMutationSecurity(req, principal);
      await revokeSession(principal);
    } catch (error) {
      // An invalid session may not be revoked, but the client must always lose its cookies.
      // CSRF failures are intentional rejections and must never be converted to success.
      if (!(error instanceof ManifoldError) || error.reasonCodes.includes("CSRF_INVALID")) throw error;
    }
    const response = contractOk(HumanAuthContracts.logoutResponse, { loggedOut: true }, requestId);
    response.headers.append("set-cookie", clearSessionCookie());
    response.headers.append("set-cookie", clearCsrfCookie());
    return response;
  });
}
