import { sha256Canonical } from "@manifold/config";
import { genId } from "@/lib/ids";
import { ManifoldError } from "@/lib/http";
import type { Sql } from "@/lib/db";

export const ENDPOINT_KINDS = new Set(["chat", "responses", "embeddings"]);
const TOP_LEVEL_REVISION_FIELDS = new Set(["mode", "targets", "retryPolicy", "timeoutPolicy", "capturePolicy"]);
const TARGET_FIELDS = new Set(["clientRef", "providerCredentialId", "offeringId", "baseUrl", "deployment", "region", "weight", "priority"]);
const RETRY_FIELDS = new Set(["maxAttempts", "retryOn", "backoffMs", "providerIdempotency"]);
const PROVIDER_IDEMPOTENCY_FIELDS = new Set(["targetRef", "headerName"]);
const TIMEOUT_FIELDS = new Set(["connectMs", "firstByteMs", "overallMs"]);

export interface TargetInput {
  /** Request-local reference; it is never used as a database primary key. */
  clientRef?: string;
  providerCredentialId: string;
  offeringId: string;
  baseUrl: string | null;
  deployment: Record<string, unknown> | null;
  region: string | null;
  weight: number;
  priority: number;
}

export interface RevisionInput {
  mode: "ordered" | "weighted";
  targets: TargetInput[];
  retryPolicy: Record<string, unknown>;
  providerIdempotency?: { targetRef: string; headerName: "idempotency-key" };
  timeoutPolicy: Record<string, unknown>;
  capturePolicy: Record<string, unknown> | null;
}

function validation(message: string, path?: string): never {
  throw new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [], details: path ? { issues: [{ path, message }] } : undefined });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) validation(`${path} must be an object`, path);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) validation(`unknown field '${path}.${key}'`, `${path}.${key}`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) validation(`${path} must be a non-empty string`, path);
  return value;
}

function optionalString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") validation(`${path} must be a string`, path);
  return value;
}

function nonNegativeInteger(value: unknown, fallback: number, path: string): number {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || (actual as number) < 0) validation(`${path} must be a non-negative integer`, path);
  return actual as number;
}

/** Parse the public camelCase contract and store the spec's snake_case policy JSON. */
export function parseRevision(body: Record<string, unknown>): RevisionInput {
  exactKeys(body, TOP_LEVEL_REVISION_FIELDS, "body");
  const mode = body.mode === undefined ? "ordered" : body.mode;
  if (mode !== "ordered" && mode !== "weighted") validation("mode must be 'ordered' or 'weighted'", "mode");
  if (!Array.isArray(body.targets) || body.targets.length === 0) validation("targets must be a non-empty array", "targets");
  const targets = body.targets.map((value, index) => {
    const target = object(value, `targets[${index}]`);
    exactKeys(target, TARGET_FIELDS, `targets[${index}]`);
    const deployment = target.deployment === undefined || target.deployment === null ? null : object(target.deployment, `targets[${index}].deployment`);
    return {
      ...(target.clientRef === undefined ? {} : { clientRef: nonEmptyString(target.clientRef, `targets[${index}].clientRef`) }),
      providerCredentialId: nonEmptyString(target.providerCredentialId, `targets[${index}].providerCredentialId`),
      offeringId: nonEmptyString(target.offeringId, `targets[${index}].offeringId`),
      baseUrl: optionalString(target.baseUrl, `targets[${index}].baseUrl`),
      deployment,
      region: optionalString(target.region, `targets[${index}].region`),
      weight: nonNegativeInteger(target.weight, 1, `targets[${index}].weight`),
      priority: nonNegativeInteger(target.priority, 0, `targets[${index}].priority`),
    };
  });
  const clientRefs = targets.flatMap((target) => target.clientRef ? [target.clientRef] : []);
  if (new Set(clientRefs).size !== clientRefs.length) validation("targets must not repeat clientRef", "targets");
  if (mode === "weighted" && !targets.some((target) => target.weight > 0)) validation("weighted routes require at least one target with weight > 0", "targets");

  const retry = body.retryPolicy === undefined ? {} : object(body.retryPolicy, "retryPolicy");
  exactKeys(retry, RETRY_FIELDS, "retryPolicy");
  const maxAttempts = nonNegativeInteger(retry.maxAttempts, 1, "retryPolicy.maxAttempts");
  if (maxAttempts < 1) validation("retryPolicy.maxAttempts must be at least 1", "retryPolicy.maxAttempts");
  const retryOn = retry.retryOn === undefined ? [] : retry.retryOn;
  if (!Array.isArray(retryOn) || retryOn.some((item) => typeof item !== "string" || item.length === 0)) validation("retryPolicy.retryOn must be an array of non-empty strings", "retryPolicy.retryOn");
  let providerIdempotency: RevisionInput["providerIdempotency"];
  if (retry.providerIdempotency !== undefined) {
    const contract = object(retry.providerIdempotency, "retryPolicy.providerIdempotency");
    exactKeys(contract, PROVIDER_IDEMPOTENCY_FIELDS, "retryPolicy.providerIdempotency");
    const targetRef = nonEmptyString(contract.targetRef, "retryPolicy.providerIdempotency.targetRef");
    if (contract.headerName !== "idempotency-key") {
      validation("retryPolicy.providerIdempotency.headerName must be 'idempotency-key'", "retryPolicy.providerIdempotency.headerName");
    }
    if (!clientRefs.includes(targetRef)) {
      validation("retryPolicy.providerIdempotency.targetRef must name a target clientRef in this revision", "retryPolicy.providerIdempotency.targetRef");
    }
    providerIdempotency = { targetRef, headerName: "idempotency-key" };
  }
  const retryPolicy = {
    max_attempts: maxAttempts,
    retry_on: retryOn,
    backoff_ms: nonNegativeInteger(retry.backoffMs, 0, "retryPolicy.backoffMs"),
  };

  const timeout = body.timeoutPolicy === undefined ? {} : object(body.timeoutPolicy, "timeoutPolicy");
  exactKeys(timeout, TIMEOUT_FIELDS, "timeoutPolicy");
  const connectMs = nonNegativeInteger(timeout.connectMs, 0, "timeoutPolicy.connectMs");
  const firstByteMs = nonNegativeInteger(timeout.firstByteMs, 0, "timeoutPolicy.firstByteMs");
  const overallMs = nonNegativeInteger(timeout.overallMs, 60_000, "timeoutPolicy.overallMs");
  if (overallMs < 1 || (connectMs && connectMs > overallMs) || (firstByteMs && firstByteMs > overallMs)) validation("timeoutPolicy values must not exceed overallMs and overallMs must be positive", "timeoutPolicy");
  const timeoutPolicy = { connect_ms: connectMs, first_byte_ms: firstByteMs, overall_ms: overallMs };
  const capturePolicy = body.capturePolicy === undefined || body.capturePolicy === null ? null : object(body.capturePolicy, "capturePolicy");
  return { mode, targets, retryPolicy, ...(providerIdempotency ? { providerIdempotency } : {}), timeoutPolicy, capturePolicy };
}

export async function insertRevision(sql: Sql, workspaceId: string, routeId: string, createdBy: string | null, input: RevisionInput): Promise<{ revisionId: string; contentHash: string }> {
  const offerings = new Map<string, { adapter_revision: string; endpoint_kinds: unknown; provider: string; capabilities: unknown }>();
  for (const target of input.targets) {
    const credential = await sql<{ id: string; provider: string }[]>`SELECT id, provider FROM provider_credential WHERE id = ${target.providerCredentialId} AND workspace_id = ${workspaceId} AND revoked_at IS NULL LIMIT 1`;
    if (!credential[0]) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "provider credential not found", reasonCodes: [] });
    let offering = offerings.get(target.offeringId);
    if (!offering) {
      const rows = await sql<{ adapter_revision: string; endpoint_kinds: unknown; provider: string; capabilities: unknown }[]>`SELECT adapter_revision, endpoint_kinds, provider, capabilities FROM provider_model_offering WHERE id = ${target.offeringId} LIMIT 1`;
      offering = rows[0];
      if (!offering) throw new ManifoldError({ status: 404, code: "OFFERING_NOT_FOUND", message: "offering not found", reasonCodes: [] });
      offerings.set(target.offeringId, offering);
    }
    if (credential[0].provider !== offering.provider) validation("provider credential and offering must use the same provider", "targets");
  }
  const routeRows = await sql<{ endpoint_kind: string }[]>`SELECT endpoint_kind FROM gateway_route WHERE id = ${routeId} AND workspace_id = ${workspaceId} LIMIT 1`;
  const route = routeRows[0];
  if (!route) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "route not found", reasonCodes: [] });
  for (const target of input.targets) {
    const offering = offerings.get(target.offeringId)!;
    if (!Array.isArray(offering.endpoint_kinds) || !offering.endpoint_kinds.includes(route.endpoint_kind)) validation(`offering does not support route endpoint '${route.endpoint_kind}'`, "targets");
  }
  const idempotencyTarget = input.providerIdempotency
    ? input.targets.find((target) => target.clientRef === input.providerIdempotency!.targetRef)
    : undefined;
  if (input.providerIdempotency && (!idempotencyTarget || !supportsProviderIdempotency(offerings.get(idempotencyTarget.offeringId)!.capabilities))) {
    validation("retryPolicy.providerIdempotency requires an offering adapter with providerIdempotency: 'supported'", "retryPolicy.providerIdempotency");
  }
  const canonicalTargets = input.targets.map((target) => ({ ...target, adapterRevision: offerings.get(target.offeringId)!.adapter_revision }));
  const contentHash = sha256Canonical({ routeId, mode: input.mode, retryPolicy: input.retryPolicy, providerIdempotency: input.providerIdempotency, timeoutPolicy: input.timeoutPolicy, capturePolicy: input.capturePolicy, targets: canonicalTargets });
  const existing = await sql<{ id: string }[]>`SELECT id FROM gateway_route_revision WHERE route_id = ${routeId} AND content_hash = ${contentHash} LIMIT 1`;
  if (existing[0]) return { revisionId: existing[0].id, contentHash };
  const revisionId = genId("rev");
  const persistedTargets = canonicalTargets.map((target) => ({ ...target, targetId: genId("tgt") }));
  const persistedRetryPolicy = {
    ...input.retryPolicy,
    ...(input.providerIdempotency ? {
      provider_idempotency: {
        target_id: persistedTargets.find((target) => target.clientRef === input.providerIdempotency!.targetRef)!.targetId,
        header_name: "idempotency-key" as const,
      },
    } : {}),
  };
  await sql`INSERT INTO gateway_route_revision (id, workspace_id, route_id, mode, retry_policy, timeout_policy, capture_policy, content_hash, created_by) VALUES (${revisionId}, ${workspaceId}, ${routeId}, ${input.mode}, ${sql.json(persistedRetryPolicy as never)}, ${sql.json(input.timeoutPolicy as never)}, ${input.capturePolicy ? sql.json(input.capturePolicy as never) : null}, ${contentHash}, ${createdBy})`;
  for (const target of persistedTargets) await sql`INSERT INTO gateway_target (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url, deployment, region, weight, priority) VALUES (${target.targetId}, ${workspaceId}, ${revisionId}, ${target.providerCredentialId}, ${target.offeringId}, ${target.adapterRevision}, ${target.baseUrl}, ${target.deployment ? sql.json(target.deployment as never) : null}, ${target.region}, ${target.weight}, ${target.priority})`;
  return { revisionId, contentHash };
}

/** The signed offering's adapter capability is authoritative; no provider-name allowlist exists. */
function supportsProviderIdempotency(capabilities: unknown): boolean {
  return capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities) &&
    (capabilities as Record<string, unknown>).providerIdempotency === "supported";
}
