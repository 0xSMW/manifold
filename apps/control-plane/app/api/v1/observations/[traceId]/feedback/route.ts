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

function feedbackInput(body: Record<string, unknown>): {
  score: number | null;
  label: string | null;
} {
  const unknown = Object.keys(body).filter((key) => key !== "score" && key !== "label");
  if (unknown.length) validation(unknown[0]!, "unknown field");
  const score = body.score;
  if (
    score !== undefined &&
    score !== null &&
    (typeof score !== "number" || !Number.isFinite(score) || score < -1 || score > 1)
  ) {
    validation("score", "score must be a finite number between -1 and 1");
  }
  const label = body.label;
  if (
    label !== undefined &&
    label !== null &&
    (typeof label !== "string" || !label.trim() || label.trim().length > 128)
  ) {
    validation("label", "label must be a non-empty string of at most 128 characters");
  }
  if ((score === undefined || score === null) && (label === undefined || label === null)) {
    validation("score", "feedback requires a score or label");
  }
  return {
    score: typeof score === "number" ? score : null,
    label: typeof label === "string" ? label.trim() : null,
  };
}

export async function POST(
  req: Request,
  context: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "observations:read");
    const traceId = traceIdValue((await context.params).traceId);
    const input = feedbackInput(await contractBody(req, ObservationContracts.feedback));
    const source = principal.actorKind === "member" ? "member" : "api_token";

    const result = await withWorkspace(principal.workspaceId, (sql) =>
      runIdempotentMutation(
        sql,
        principal,
        req,
        `/api/v1/observations/${encodeURIComponent(traceId)}/feedback`,
        { traceId, ...input },
        async () => {
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
          const id = genId("fb");
          const rows = await sql<
            { id: string; score: string | number | null; label: string | null; source: string; created_at: string }[]
          >`
            INSERT INTO feedback_event (id, workspace_id, trace_id, score, label, source)
            VALUES (
              ${id}, ${principal.workspaceId}, ${traceId}, ${input.score}, ${input.label}, ${source}
            )
            RETURNING id, score, label, source, created_at`;
          await audit(sql, principal, {
            action: "observation.feedback",
            targetKind: "observation",
            targetId: traceId,
            requestId,
            detail: { feedback_id: id, score: input.score, label: input.label, source },
          });
          const created = rows[0]!;
          return {
            status: 201,
            body: {
              id: created.id,
              trace_id: traceId,
              score: created.score === null ? null : String(created.score),
              label: created.label,
              source: created.source,
              created_at: created.created_at,
            },
          };
        },
      ),
    );
    return contractOk(ObservationContracts.feedbackResponse, result.body, requestId, result.status);
  });
}
