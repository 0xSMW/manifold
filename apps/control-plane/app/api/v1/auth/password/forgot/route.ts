import { requestPasswordReset } from "@/lib/human-auth";
import { contractBody, contractOk } from "@/lib/contracts";
import { wrapInEnvelope } from "@/lib/http";
import { HumanAuthContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => { const { email } = await contractBody(req, HumanAuthContracts.forgotPassword); try { await requestPasswordReset(email, req); } catch { /* generic acknowledgement */ } return contractOk(HumanAuthContracts.forgotPasswordResponse, { accepted: true }, requestId); }); }
