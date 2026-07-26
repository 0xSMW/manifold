import { resetPassword } from "@/lib/human-auth";
import { contractBody, contractOk } from "@/lib/contracts";
import { wrapInEnvelope, ManifoldError } from "@/lib/http";
import { HumanAuthContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => { const body = await contractBody(req, HumanAuthContracts.resetPassword); if (!(await resetPassword(body.token, body.password, req))) throw new ManifoldError({ status: 400, code: "VALIDATION", message: "reset link is unavailable", reasonCodes: ["RESET_INVALID"] }); return contractOk(HumanAuthContracts.resetPasswordResponse, { reset: true }, requestId); }); }
