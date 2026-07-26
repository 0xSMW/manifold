import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth";
import { contractBody, contractOk } from "@/lib/contracts";
import { withWorkspace } from "@/lib/db";
import { genId } from "@/lib/ids";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { ObservationContracts } from "@manifold/contracts";
import { runIdempotentMutation } from "../../_mutation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validation(path: string, message: string): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message,
    reasonCodes: [],
    details: { issues: [{ path, message }] },
  });
}

function traceIdValue(value: string): string {
  let traceId: string;
  try {
    traceId = decodeURIComponent(value).trim();
  } catch {
    traceId = "";
  }
  if (!traceId || traceId.length > 256) validation("traceId", "invalid trace id");
  return traceId;
}

function annotationInput(body: Record<string, unknown>): {
  body: string | null;
  tags: string[];
} {
  const unknown = Object.keys(body).filter((key) => key !== "body" && key !== "tags");
  if (unknown.length) validation(unknown[0]!, "unknown field");
  const text = body.body;
  if (text !== undefined && text !== null && typeof text !== "string") {
    validation("body", "body must be a string or null");
  }
  const normalizedBody = typeof text === "string" ? text.trim() : null;
  if (normalizedBody && normalizedBody.length > 4_000) {
    validation("body", "body must be at most 4000 characters");
  }
  const rawTags = body.tags ?? [];
  if (
    !Array.isArray(rawTags) ||
    rawTags.length > 20 ||
    rawTags.some(
      (tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 64,
    )
  ) {
    validation("tags", "tags must contain at most 20 non-empty strings of at most 64 characters");
  }
  const tags = [...new Set((rawTags as string[]).map((tag) => tag.trim()))];
  if (!normalizedBody && tags.length === 0) {
    validation("body", "an annotation requires a body or at least one tag");
  }
  return { body: normalizedBody || null, tags };
}

export async function POST(
  req: Request,
  context: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "observations:read");
    if (principal.actorKind !== "member" || !principal.member) {
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "annotations require an authenticated member actor",
        reasonCodes: [],
        remediation: "use a signed-in console member session",
      });
    }
    const member = principal.member;
    const traceId = traceIdValue((await context.params).traceId);
    const input = annotationInput(await contractBody(req, ObservationContracts.annotation));

    const result = await withWorkspace(principal.workspaceId, (sql) =>
      runIdempotentMutation(
        sql,
        principal,
        req,
        `/api/v1/observations/${encodeURIComponent(traceId)}/annotations`,
        { traceId, ...input },
        async () => {
          const pressure = await sql<{ block_non_essential_growth: boolean }[]>`
            SELECT block_non_essential_growth
            FROM storage_pressure_state
            WHERE workspace_id = ${principal.workspaceId}
            LIMIT 1`;
          if (pressure[0]?.block_non_essential_growth) {
            throw new ManifoldError({
              status: 429,
              code: "RATE_LIMITED",
              message: "annotations are temporarily paused while storage pressure is critical",
              reasonCodes: ["STORAGE_EMERGENCY_SHED"],
              remediation: "retry after storage pressure recovers",
            });
          }
          const traces = await sql<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM observation
              WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}
              UNION ALL
              SELECT 1 FROM trace_summary
              WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}
            ) AS exists`;
          if (!traces[0]?.exists) {
            throw new ManifoldError({
              status: 404,
              code: "NOT_FOUND",
              message: "observation trace not found",
              reasonCodes: [],
            });
          }
          const id = genId("ann");
          const rows = await sql<
            { id: string; author_id: string; body: string | null; tags: unknown; created_at: string; updated_at: string }[]
          >`
            INSERT INTO annotation (id, workspace_id, trace_id, author_id, body, tags)
            VALUES (
              ${id}, ${principal.workspaceId}, ${traceId}, ${member.id},
              ${input.body}, ${sql.json(input.tags as never)}
            )
            RETURNING id, author_id, body, tags, created_at, updated_at`;
          await audit(sql, principal, {
            action: "observation.annotate",
            targetKind: "observation",
            targetId: traceId,
            requestId,
            detail: { annotation_id: id, tags: input.tags },
          });
          const created = rows[0]!;
          return {
            status: 201,
            body: {
              id: created.id,
              trace_id: traceId,
              author_id: created.author_id,
              body: created.body,
              tags: Array.isArray(created.tags) ? created.tags : [],
              created_at: created.created_at,
              updated_at: created.updated_at,
            },
          };
        },
      ),
    );
    return contractOk(ObservationContracts.annotationResponse, result.body, requestId, result.status);
  });
}
