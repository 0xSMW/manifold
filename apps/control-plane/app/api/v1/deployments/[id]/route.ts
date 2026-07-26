import { GET as getInstallation } from "@/app/api/v1/installations/[id]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A deployment detail is an installation plus its trusted-host ingress profiles. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return getInstallation(req, ctx);
}
