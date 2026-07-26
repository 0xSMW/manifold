import { activationStatus } from "@/lib/human-auth";
import { contractOk } from "@/lib/contracts";
import { wrapInEnvelope } from "@/lib/http";
import { HumanAuthContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET() { return wrapInEnvelope(async (requestId) => {
  const configured = await activationStatus();
  return contractOk(HumanAuthContracts.activationStatus, { required: !configured, configured }, requestId);
}); }
