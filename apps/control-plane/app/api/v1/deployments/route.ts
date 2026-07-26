import { GET as listInstallations } from "@/app/api/v1/installations/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deployments are the console projection of gateway installations (§11). */
export async function GET(req: Request): Promise<Response> {
  return listInstallations(req);
}
