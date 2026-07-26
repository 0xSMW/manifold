import { timingSafeEqual } from "node:crypto";
import { drainPendingKeyPublications, reconcilePendingConfigOperations } from "@/lib/snapshot";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { InternalContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const expected = process.env.CRON_SECRET;
    const presented = req.headers.get("authorization");
    const actual = presented?.startsWith("Bearer ") ? Buffer.from(presented.slice(7)) : null;
    const secret = expected ? Buffer.from(expected) : null;
    if (!actual || !secret || actual.length !== secret.length || !timingSafeEqual(actual, secret)) {
      throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing cron secret", reasonCodes: [] });
    }
    const [config, keys] = await Promise.all([
      reconcilePendingConfigOperations(),
      drainPendingKeyPublications(),
    ]);
    return contractOk(InternalContracts.configPublicationRecoveryResponse, { config, keys }, requestId);
  });
}
