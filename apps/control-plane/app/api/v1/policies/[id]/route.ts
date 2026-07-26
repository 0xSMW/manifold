import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractOk } from "@/lib/contracts";
import { PolicyEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PolicyRow = { id: string; name: string; active_revision_id: string | null; created_at: string; updated_at: string };
type RevisionRow = { id: string; content_hash: string; created_by: string | null; created_at: string };
type EntitlementRow = { id: string; policy_revision_id: string; subject_kind: string; subject_ref: string | null; canonical_model_id: string | null; offering_id: string | null; effect: string; created_at: string };
type RequestConstraintRow = { id: string; policy_revision_id: string; param: string; max_value: string | null; min_value: string | null; on_violation: string; created_at: string };
type DataHandlingRow = { id: string; policy_revision_id: string; capture_mode: string; redaction: unknown; allowed_regions: unknown; created_at: string };
type ApprovalRow = { id: string; policy_revision_id: string; approved_by: string; reason: string | null; created_at: string };

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "policies:read");
    const { id } = await context.params;
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const policy = (await sql<PolicyRow[]>`SELECT id, name, active_revision_id, created_at, updated_at FROM gateway_policy WHERE id = ${id} AND workspace_id = ${principal.workspaceId} AND archived_at IS NULL LIMIT 1`)[0];
      if (!policy) return null;
      const revisions = await sql<RevisionRow[]>`SELECT id, content_hash, created_by, created_at FROM gateway_policy_revision WHERE policy_id = ${id} AND workspace_id = ${principal.workspaceId} ORDER BY created_at DESC, id DESC`;
      const revisionIds = revisions.map((revision) => revision.id);
      const entitlements = revisionIds.length ? await sql<EntitlementRow[]>`SELECT id, policy_revision_id, subject_kind, subject_ref, canonical_model_id, offering_id, effect, created_at FROM model_entitlement WHERE workspace_id = ${principal.workspaceId} AND policy_revision_id IN ${sql(revisionIds)}` : [];
      const requestConstraints = revisionIds.length ? await sql<RequestConstraintRow[]>`SELECT id, policy_revision_id, param, max_value::text, min_value::text, on_violation, created_at FROM request_constraint WHERE workspace_id = ${principal.workspaceId} AND policy_revision_id IN ${sql(revisionIds)}` : [];
      const dataHandlingConstraints = revisionIds.length ? await sql<DataHandlingRow[]>`SELECT id, policy_revision_id, capture_mode, redaction, allowed_regions, created_at FROM data_handling_constraint WHERE workspace_id = ${principal.workspaceId} AND policy_revision_id IN ${sql(revisionIds)}` : [];
      const approvals = revisionIds.length ? await sql<ApprovalRow[]>`SELECT id, policy_revision_id, approved_by, reason, created_at FROM policy_approval WHERE workspace_id = ${principal.workspaceId} AND policy_revision_id IN ${sql(revisionIds)} ORDER BY created_at DESC, id DESC` : [];
      return { policy, revisions, entitlements, requestConstraints, dataHandlingConstraints, approvals };
    });
    if (!result) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "policy not found", reasonCodes: [] });
    return contractOk(PolicyEndpointContracts.detail, {
      id: result.policy.id,
      name: result.policy.name,
      activeRevisionId: result.policy.active_revision_id,
      createdAt: result.policy.created_at,
      updatedAt: result.policy.updated_at,
      revisions: result.revisions.map((revision) => ({
        id: revision.id,
        contentHash: revision.content_hash,
        createdBy: revision.created_by,
        createdAt: revision.created_at,
        isActive: revision.id === result.policy.active_revision_id,
        entitlements: result.entitlements.filter((item) => item.policy_revision_id === revision.id).map((item) => ({ id: item.id, subjectKind: item.subject_kind, subjectRef: item.subject_ref, canonicalModelId: item.canonical_model_id, offeringId: item.offering_id, effect: item.effect, createdAt: item.created_at })),
        requestConstraints: result.requestConstraints.filter((item) => item.policy_revision_id === revision.id).map((item) => ({ id: item.id, param: item.param, maxValue: item.max_value === null ? null : Number(item.max_value), minValue: item.min_value === null ? null : Number(item.min_value), onViolation: item.on_violation, createdAt: item.created_at })),
        dataHandlingConstraints: result.dataHandlingConstraints.filter((item) => item.policy_revision_id === revision.id).map((item) => ({ id: item.id, captureMode: item.capture_mode, redaction: item.redaction, allowedRegions: item.allowed_regions, createdAt: item.created_at })),
        approvals: result.approvals.filter((item) => item.policy_revision_id === revision.id).map((item) => ({ id: item.id, approvedBy: item.approved_by, reason: item.reason, createdAt: item.created_at })),
      })),
    }, requestId);
  });
}
