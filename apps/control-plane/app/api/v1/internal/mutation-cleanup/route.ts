import { timingSafeEqual } from "node:crypto";
import { EmptyRequest, InternalContracts } from "@manifold/contracts";
import { contractOk, contractQuery } from "@/lib/contracts";
import { rawSql } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH_LIMIT = 200;

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const presented = req.headers.get("authorization");
  if (!expected || !presented || !presented.startsWith("Bearer ")) return false;
  const actual = Buffer.from(presented.slice(7));
  const secret = Buffer.from(expected);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

/** Bounded cron-only retention; the database function is the narrow cross-tenant worker seam. */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if (!authorized(req)) {
      throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing cron secret", reasonCodes: [] });
    }
    // The caller cannot tune the worker's scope; batch size belongs to the deployed service.
    contractQuery(new URL(req.url).searchParams, EmptyRequest);
    const [result] = await rawSql()<{ replay_rows_deleted: number; rate_buckets_deleted: number }[]>`
      SELECT replay_rows_deleted, rate_buckets_deleted
      FROM cleanup_expired_mutation_guards(${BATCH_LIMIT})`;
    return contractOk(InternalContracts.mutationCleanupResponse, {
      replayRowsDeleted: result?.replay_rows_deleted ?? 0,
      rateBucketsDeleted: result?.rate_buckets_deleted ?? 0,
    }, requestId);
  });
}
