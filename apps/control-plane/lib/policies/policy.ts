import { sha256Canonical } from "@manifold/config";
import { POLICY_EFFECTS, POLICY_ON_VIOLATIONS, POLICY_SUBJECT_KINDS } from "@manifold/contracts";
import type { Sql } from "@/lib/db";
import { genId } from "@/lib/ids";
import { ManifoldError } from "@/lib/http";

export interface EntitlementInput {
  subjectKind: (typeof POLICY_SUBJECT_KINDS)[number];
  subjectRef: string | null;
  canonicalModelId: string | null;
  offeringId: string | null;
  effect: (typeof POLICY_EFFECTS)[number];
}

export interface ConstraintInput {
  param: string;
  maxValue: number | null;
  minValue: number | null;
  onViolation: (typeof POLICY_ON_VIOLATIONS)[number];
}

export interface DataHandlingInput {
  captureMode: "none" | "metadata" | "redacted" | "full";
  redaction: Record<string, unknown> | null;
  allowedRegions: string[] | null;
}

export interface PolicyRevisionInput {
  entitlements: EntitlementInput[];
  requestConstraints: ConstraintInput[];
  dataHandlingConstraints: DataHandlingInput[];
}

function validation(message: string, path: string): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message,
    reasonCodes: [],
    details: { issues: [{ path, message }] },
  });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) validation(`${path} must be an object`, path);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) validation(`unknown field '${key}'`, `${path}.${key}`);
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) validation(`${path} must be a non-empty string or null`, path);
  return value;
}

function finiteOrNull(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) validation(`${path} must be a finite number or null`, path);
  return value;
}

export function parsePolicyRevision(body: Record<string, unknown>): PolicyRevisionInput {
  exactKeys(body, ["entitlements", "requestConstraints", "dataHandlingConstraints"], "body");
  const entitlements = body.entitlements;
  const requestConstraints = body.requestConstraints;
  const dataHandlingConstraints = body.dataHandlingConstraints;
  if (!Array.isArray(entitlements)) validation("entitlements must be an array", "entitlements");
  if (!Array.isArray(requestConstraints)) validation("requestConstraints must be an array", "requestConstraints");
  if (!Array.isArray(dataHandlingConstraints)) validation("dataHandlingConstraints must be an array", "dataHandlingConstraints");

  return {
    entitlements: entitlements.map((raw, index) => {
      const path = `entitlements[${index}]`;
      const value = record(raw, path);
      exactKeys(value, ["subjectKind", "subjectRef", "canonicalModelId", "offeringId", "effect"], path);
      const subjectKind = value.subjectKind;
      if (typeof subjectKind !== "string" || !POLICY_SUBJECT_KINDS.includes(subjectKind as never)) validation("subjectKind is invalid", `${path}.subjectKind`);
      const subjectRef = nullableString(value.subjectRef, `${path}.subjectRef`);
      if ((subjectKind === "all") !== (subjectRef === null)) validation("subjectRef must be null exactly when subjectKind is 'all'", `${path}.subjectRef`);
      const canonicalModelId = nullableString(value.canonicalModelId, `${path}.canonicalModelId`);
      const offeringId = nullableString(value.offeringId, `${path}.offeringId`);
      if (canonicalModelId !== null && offeringId !== null) validation("provide at most one of canonicalModelId and offeringId", path);
      const effect = value.effect ?? "allow";
      if (typeof effect !== "string" || !POLICY_EFFECTS.includes(effect as never)) validation("effect is invalid", `${path}.effect`);
      return { subjectKind: subjectKind as EntitlementInput["subjectKind"], subjectRef, canonicalModelId, offeringId, effect: effect as EntitlementInput["effect"] };
    }),
    requestConstraints: requestConstraints.map((raw, index) => {
      const path = `requestConstraints[${index}]`;
      const value = record(raw, path);
      exactKeys(value, ["param", "maxValue", "minValue", "onViolation"], path);
      if (typeof value.param !== "string" || value.param.length === 0) validation("param must be a non-empty string", `${path}.param`);
      const maxValue = finiteOrNull(value.maxValue, `${path}.maxValue`);
      const minValue = finiteOrNull(value.minValue, `${path}.minValue`);
      if (maxValue === null && minValue === null) validation("at least one bound is required", path);
      if (maxValue !== null && minValue !== null && minValue > maxValue) validation("minValue must not exceed maxValue", path);
      const onViolation = value.onViolation ?? "clamp";
      if (typeof onViolation !== "string" || !POLICY_ON_VIOLATIONS.includes(onViolation as never)) validation("onViolation is invalid", `${path}.onViolation`);
      return { param: value.param, maxValue, minValue, onViolation: onViolation as ConstraintInput["onViolation"] };
    }),
    dataHandlingConstraints: dataHandlingConstraints.map((raw, index) => {
      const path = `dataHandlingConstraints[${index}]`;
      const value = record(raw, path);
      exactKeys(value, ["captureMode", "redaction", "allowedRegions"], path);
      const captureMode = value.captureMode ?? "redacted";
      if (!["none", "metadata", "redacted", "full"].includes(captureMode as string)) validation("captureMode is invalid", `${path}.captureMode`);
      const redaction = value.redaction === undefined || value.redaction === null ? null : record(value.redaction, `${path}.redaction`);
      let allowedRegions: string[] | null = null;
      if (value.allowedRegions !== undefined && value.allowedRegions !== null) {
        if (!Array.isArray(value.allowedRegions) || value.allowedRegions.some((region) => typeof region !== "string" || region.length === 0)) validation("allowedRegions must be an array of non-empty strings or null", `${path}.allowedRegions`);
        allowedRegions = [...value.allowedRegions];
      }
      return { captureMode: captureMode as DataHandlingInput["captureMode"], redaction, allowedRegions };
    }),
  };
}

export async function insertPolicyRevision(sql: Sql, workspaceId: string, policyId: string, createdBy: string | null, input: PolicyRevisionInput): Promise<{ revisionId: string; contentHash: string }> {
  for (const entitlement of input.entitlements) {
    if (entitlement.canonicalModelId) {
      const model = await sql<{ id: string }[]>`SELECT id FROM canonical_model WHERE id = ${entitlement.canonicalModelId} LIMIT 1`;
      if (!model[0]) validation("canonicalModelId does not identify a model", "entitlements");
    }
    if (entitlement.offeringId) {
      const offering = await sql<{ id: string }[]>`SELECT id FROM provider_model_offering WHERE id = ${entitlement.offeringId} LIMIT 1`;
      if (!offering[0]) validation("offeringId does not identify an offering", "entitlements");
    }
  }
  const content = { policyId, entitlements: input.entitlements, requestConstraints: input.requestConstraints, dataHandlingConstraints: input.dataHandlingConstraints };
  const contentHash = sha256Canonical(content);
  const existing = await sql<{ id: string }[]>`SELECT id FROM gateway_policy_revision WHERE policy_id = ${policyId} AND workspace_id = ${workspaceId} AND content_hash = ${contentHash} LIMIT 1`;
  if (existing[0]) return { revisionId: existing[0].id, contentHash };

  const revisionId = genId("prev");
  await sql`INSERT INTO gateway_policy_revision (id, workspace_id, policy_id, content_hash, created_by) VALUES (${revisionId}, ${workspaceId}, ${policyId}, ${contentHash}, ${createdBy})`;
  for (const entitlement of input.entitlements) await sql`INSERT INTO model_entitlement (id, workspace_id, policy_revision_id, subject_kind, subject_ref, canonical_model_id, offering_id, effect) VALUES (${genId("ent")}, ${workspaceId}, ${revisionId}, ${entitlement.subjectKind}, ${entitlement.subjectRef}, ${entitlement.canonicalModelId}, ${entitlement.offeringId}, ${entitlement.effect})`;
  for (const constraint of input.requestConstraints) await sql`INSERT INTO request_constraint (id, workspace_id, policy_revision_id, param, max_value, min_value, on_violation) VALUES (${genId("con")}, ${workspaceId}, ${revisionId}, ${constraint.param}, ${constraint.maxValue}, ${constraint.minValue}, ${constraint.onViolation})`;
  for (const constraint of input.dataHandlingConstraints) await sql`INSERT INTO data_handling_constraint (id, workspace_id, policy_revision_id, capture_mode, redaction, allowed_regions) VALUES (${genId("dhc")}, ${workspaceId}, ${revisionId}, ${constraint.captureMode}, ${constraint.redaction ? sql.json(constraint.redaction as never) : null}, ${constraint.allowedRegions ? sql.json(constraint.allowedRegions as never) : null})`;
  return { revisionId, contentHash };
}
