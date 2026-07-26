import { timingSafeEqual } from "node:crypto";
import { rawSql } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { InternalContracts } from "@manifold/contracts";
import { drainTargetHealthRollups } from "@/lib/target-health";
import { drainTargetHealthPublications } from "@/lib/target-health-publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKSPACE_LIMIT = 25;
const ROLLUP_LIMIT_PER_WORKSPACE = 50;
const PUBLICATION_LIMIT_PER_WORKSPACE = 25;

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const presented = req.headers.get("authorization");
  if (!expected || !presented || !presented.startsWith("Bearer ")) return false;

  const actual = Buffer.from(presented.slice(7));
  const secret = Buffer.from(expected);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

/**
 * Bounded Vercel Cron dispatcher. Workspace discovery is deliberately the only
 * cross-tenant query; each roll-up performs its own workspace-scoped work.
 */
export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    if (!authorized(req)) {
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "invalid or missing cron secret",
        reasonCodes: [],
      });
    }

    const rows = await rawSql()<{ workspace_id: string }[]>`
      SELECT workspace_id FROM target_health_due_workspaces(${WORKSPACE_LIMIT})`;
    const results = [];
    // Sequential workspace processing keeps a single Cron invocation from fanning out its
    // database pool.  Publishing follows reduction so each pass can carry freshly changed state.
    for (const { workspace_id: workspaceId } of rows) {
      const rollups = await drainTargetHealthRollups(workspaceId, ROLLUP_LIMIT_PER_WORKSPACE);
      const publications = await drainTargetHealthPublications(workspaceId, PUBLICATION_LIMIT_PER_WORKSPACE);
      results.push({ rollups, publications });
    }

    return contractOk(InternalContracts.targetHealthCronResponse, {
      workspaces: rows.length,
      claimed: results.reduce((total, result) => total + result.rollups.claimed + result.publications.claimed, 0),
      rolledUp: results.reduce((total, result) => total + result.rollups.rolledUp, 0),
      changed: results.reduce((total, result) => total + result.rollups.changed, 0),
      published: results.reduce((total, result) => total + result.publications.published, 0),
      noop: results.reduce((total, result) => total + result.publications.noop, 0),
      retried: results.reduce((total, result) => total + result.rollups.retried + result.publications.retried, 0),
      dead: results.reduce((total, result) => total + result.publications.dead, 0),
    }, requestId);
  });
}
