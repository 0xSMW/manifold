// POST /api/v1/session/login — exchange an existing bearer API token for an opaque browser cookie.
import { createSession, sessionCookie } from "@/lib/session";
import { wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { SessionLoginResponse } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const session = await createSession(req);
    // The response intentionally contains no source token and no session plaintext.
    const response = contractOk(SessionLoginResponse,
      { member: session.member, role: session.member.role, expiresAt: session.expiresAt },
      requestId,
      201,
    );
    response.headers.set("set-cookie", sessionCookie(session.plaintext, session.expiresAt));
    return response;
  });
}
