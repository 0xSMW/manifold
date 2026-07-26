import { type PolicyInput, type PolicyRevision } from "@manifold/gateway-policy";
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { simulatePolicy } from "@/lib/policies/simulate";
import { contractBody, contractOk } from "@/lib/contracts";
import { PolicyEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalid(message: string, path: string): never {
  throw new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [], details: { issues: [{ path, message }] } });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${path} must be an object`, path);
  return value as Record<string, unknown>;
}

function parseInput(body: Record<string, unknown>): { revisionId: string; input: PolicyInput } {
  for (const key of Object.keys(body)) if (!["revisionId", "subject", "canonicalModelId", "params"].includes(key)) invalid(`unknown field '${key}'`, key);
  if (typeof body.revisionId !== "string" || body.revisionId.length === 0) invalid("revisionId must be a non-empty string", "revisionId");
  if (typeof body.canonicalModelId !== "string" || body.canonicalModelId.length === 0) invalid("canonicalModelId must be a non-empty string", "canonicalModelId");
  const subject = object(body.subject, "subject");
  for (const key of Object.keys(subject)) if (!["keyScope", "team", "costCenter", "app"].includes(key)) invalid(`unknown field '${key}'`, `subject.${key}`);
  for (const [key, value] of Object.entries(subject)) if (typeof value !== "string" || value.length === 0) invalid(`subject.${key} must be a non-empty string`, `subject.${key}`);
  const params = object(body.params, "params");
  for (const [key, value] of Object.entries(params)) if (typeof value !== "number" || !Number.isFinite(value)) invalid(`params.${key} must be a finite number`, `params.${key}`);
  return { revisionId: body.revisionId, input: { subject: subject as PolicyInput["subject"], canonicalModelId: body.canonicalModelId, params: params as Record<string, number> } };
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "policies:read");
    const { id } = await context.params;
    const { revisionId, input } = parseInput(await contractBody(req, PolicyEndpointContracts.simulate));
    const revision = await withWorkspace(principal.workspaceId, async (sql) => {
      const exists = await sql<{ id: string }[]>`SELECT r.id FROM gateway_policy_revision r JOIN gateway_policy p ON p.id = r.policy_id AND p.workspace_id = ${principal.workspaceId} WHERE r.id = ${revisionId} AND r.policy_id = ${id} AND r.workspace_id = ${principal.workspaceId} AND p.archived_at IS NULL LIMIT 1`;
      if (!exists[0]) return null;
      const [entitlements, constraints] = await Promise.all([
        sql<{ subject_kind: PolicyRevision["modelEntitlements"][number]["subjectKind"]; subject_ref: string | null; canonical_model_id: string | null; offering_canonical_model_id: string | null; effect: PolicyRevision["modelEntitlements"][number]["effect"] }[]>`SELECT e.subject_kind, e.subject_ref, e.canonical_model_id, o.canonical_model_id AS offering_canonical_model_id, e.effect FROM model_entitlement e LEFT JOIN provider_model_offering o ON o.id = e.offering_id WHERE e.workspace_id = ${principal.workspaceId} AND e.policy_revision_id = ${revisionId}`,
        sql<{ param: string; max_value: string | null; min_value: string | null; on_violation: PolicyRevision["requestConstraints"][number]["onViolation"] }[]>`SELECT param, max_value::text, min_value::text, on_violation FROM request_constraint WHERE workspace_id = ${principal.workspaceId} AND policy_revision_id = ${revisionId}`,
      ]);
      return {
        modelEntitlements: entitlements.map((entry) => ({ subjectKind: entry.subject_kind, subjectRef: entry.subject_ref, canonicalModelId: entry.canonical_model_id ?? entry.offering_canonical_model_id, effect: entry.effect })),
        requestConstraints: constraints.map((entry) => ({ param: entry.param, maxValue: entry.max_value === null ? null : Number(entry.max_value), minValue: entry.min_value === null ? null : Number(entry.min_value), onViolation: entry.on_violation })),
      } satisfies PolicyRevision;
    });
    if (!revision) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "policy revision not found", reasonCodes: [] });
    const decision = simulatePolicy(input, revision);
    return contractOk(PolicyEndpointContracts.simulateResponse, { policyId: id, revisionId, outcome: decision.outcome, reasonCodes: decision.reasonCodes, clamps: decision.clamps ?? {} }, requestId);
  });
}
