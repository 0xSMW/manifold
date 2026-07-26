import { timingSafeEqual } from "node:crypto";
import { sweepExpiredKeyRotationGrace } from "@/lib/keys/grace-expiry";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk, contractQuery } from "@/lib/contracts";
import { EmptyRequest, InternalContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const presented = req.headers.get("authorization");
  if (!expected || !presented || !presented.startsWith("Bearer ")) return false;
  const actual = Buffer.from(presented.slice(7)); const secret = Buffer.from(expected);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

/** Bounded internal cron: expires rotated predecessors and publishes only their keys sections. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if (!authorized(req)) throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing cron secret", reasonCodes: [] });
    contractQuery(new URL(req.url).searchParams, EmptyRequest);
    return contractOk(InternalContracts.keyGraceExpiryResponse, await sweepExpiredKeyRotationGrace(requestId), requestId);
  });
}
