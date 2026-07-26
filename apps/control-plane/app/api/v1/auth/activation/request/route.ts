import { activationStatus, requestActivation } from "@/lib/human-auth";
import { contractBody, contractOk } from "@/lib/contracts";
import { wrapInEnvelope } from "@/lib/http";
import { HumanAuthContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => { const { email } = await contractBody(req, HumanAuthContracts.activationRequest); try { if (!(await activationStatus())) await requestActivation(email, req); } catch { /* Generic acknowledgement prevents discovery and email transport details. */ } return contractOk(HumanAuthContracts.activationRequestResponse, { accepted: true }, requestId); }); }
