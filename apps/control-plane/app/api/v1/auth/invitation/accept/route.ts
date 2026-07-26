import { acceptInvitation } from "@/lib/human-auth";
import { contractBody, contractOk } from "@/lib/contracts";
import { csrfCookie, sessionCookie } from "@/lib/session";
import { wrapInEnvelope } from "@/lib/http";
import { HumanAuthContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => { const body = await contractBody(req, HumanAuthContracts.invitationAccept); const s = await acceptInvitation(body.token, body.name, body.password, req.headers.get("user-agent"), req); const r = contractOk(HumanAuthContracts.invitationAcceptResponse, { member: s.member, role: s.member.role, expiresAt: s.expiresAt }, requestId, 201); r.headers.append("set-cookie", sessionCookie(s.plaintext, s.expiresAt)); r.headers.append("set-cookie", csrfCookie(s.csrf, s.expiresAt)); return r; }); }
