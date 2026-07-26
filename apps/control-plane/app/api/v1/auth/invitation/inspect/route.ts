import { inspectInvitation } from "@/lib/human-auth";
import { contractBody, contractOk } from "@/lib/contracts";
import { wrapInEnvelope } from "@/lib/http";
import { HumanAuthContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => contractOk(HumanAuthContracts.invitationInspectResponse, await inspectInvitation((await contractBody(req, HumanAuthContracts.invitationInspect)).token), requestId)); }
