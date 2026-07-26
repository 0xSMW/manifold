// POST /api/v1/session/login — exchange an existing bearer API token for an opaque browser cookie.
import { createSession, csrfCookie, sessionCookie } from "@/lib/session";
import { wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { SessionLoginResponse } from "@manifold/contracts";
import { ManifoldError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if (process.env.NODE_ENV === "production" || process.env.MANIFOLD_ENABLE_LEGACY_TOKEN_LOGIN !== "true") {
      throw new ManifoldError({ status: 410, code: "NOT_FOUND", message: "token-to-browser login is no longer available", reasonCodes: ["LEGACY_BROWSER_LOGIN_DISABLED"] });
    }
    const session = await createSession(req);
    // The response intentionally contains no source token and no session plaintext.
    const response = contractOk(SessionLoginResponse,
      { member: session.member, role: session.member.role, expiresAt: session.expiresAt },
      requestId,
      201,
    );
    response.headers.append("set-cookie", sessionCookie(session.plaintext, session.expiresAt));
    response.headers.append("set-cookie", csrfCookie(session.csrf, session.expiresAt));
    return response;
  });
}
