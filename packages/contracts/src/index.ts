// @manifold/contracts — the wire contract. Pins schema version, reason codes, error envelopes.
// Per SPEC §0.2, §0.3, §4.3. This package has no runtime deps beyond zod.
import { z } from "zod";

/** SPEC §4.3 / ADR-0002: protocol schema id, brand-independent. */
export const SCHEMA_VERSION = "manifold.v1" as const;

/**
 * Reason-code registry (SPEC §0.2). Stable SCREAMING_SNAKE_CASE strings, namespaced by class.
 * This enum is the single source; the §0.2 table is generated from it in CI so drift fails the build.
 */
export const REASON_CODES = [
  // auth
  "AUTH_KEY_UNKNOWN",
  "AUTH_KEY_REVOKED",
  "AUTH_KEY_EXPIRED",
  "AUTH_PROFILE_MISMATCH",
  "AUTH_TOKEN_AUDIENCE",
  "AUTH_WORKLOAD_IDENTITY",
  // policy
  "POLICY_MODEL_DENIED",
  "POLICY_PROFILE_ESCALATION",
  "POLICY_PARAM_CLAMPED",
  "POLICY_PARAM_REJECTED",
  "POLICY_BODY_TOO_LARGE",
  "POLICY_DATA_REGION",
  "POLICY_CAPTURE_FORCED",
  // budget
  "BUDGET_RESERVE_DENIED",
  "BUDGET_PRICE_UNKNOWN",
  "BUDGET_RESERVE_EXPIRED",
  // routing
  "ROUTE_UNKNOWN",
  "ROUTE_NO_HEALTHY_TARGET",
  "ROUTE_ENDPOINT_UNSUPPORTED",
  "RETRY_ATTEMPT",
  "FAILOVER_ATTEMPT",
  // upstream
  "PROVIDER_TIMEOUT",
  "PROVIDER_HTTP_5XX",
  "PROVIDER_HTTP_4XX",
  "PROVIDER_STREAM_ABORTED",
  // limit
  "RATE_LIMIT_KEY",
  // ingest
  "CAPTURE_TRUNCATED",
  "INGEST_DEDUP",
  // storage
  "STORAGE_SHED_SAMPLED",
  "STORAGE_EMERGENCY_SHED",
  // config
  "CONFIG_PRECONDITION_FAILED",
  "CONFIG_TRIPWIRE_HELD",
  // guard — terminal codes the gateway emits into an observation's reasonCodes[] before any
  // provider dispatch: pre-auth profile miss, egress (SSRF) block, credential decrypt failure.
  // handleRequest.emitTerminal stamps these into a ReasonCode[] (§8.3), so they must be registered.
  "PROFILE_UNKNOWN",
  "SSRF_BLOCKED",
  "CREDENTIAL_UNAVAILABLE",
] as const;

export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;

/**
 * Control-plane error codes (SPEC §10.3). Distinct enum from ReasonCode (review M5):
 * ErrorCode populates control-plane `error.code`; ReasonCode populates `error.reason_codes[]`.
 */
export const ERROR_CODES = [
  "CONFIG_PRECONDITION_FAILED",
  "CONFIG_TRIPWIRE_HELD",
  "DUPLICATE_ROUTE",
  "OFFERING_NOT_FOUND",
  "KEY_NOT_ACTIVE",
  "ALREADY_APPROVED",
  "ALLOCATION_EXCEEDS_PARENT",
  "HOSTNAME_TAKEN",
  "USER_CODE_INVALID",
  "THRESHOLDS_UNORDERED",
  "COMPACTION_IN_PROGRESS",
  "REVISION_NOT_FOUND",
  "INVALID_TRANSITION",
  "IMMUTABLE_ROW",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMITED",
  "VALIDATION",
  "NOT_FOUND",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ────────────────────────────────────────────────────────────────────────────
// Policy vocabulary (SPEC §6.6). Single source for the governance literal sets
// `subject_kind` / `effect` / `on_violation`. Owned here (the leaf) so ports,
// gateway-policy, and the DB CHECKs never drift: @manifold/ports and
// @manifold/gateway-policy re-export these; the `model_entitlement` /
// `request_constraint` CHECK constraints in @manifold/database derive from the
// SAME literal set (kept in sync by hand — see the comment on those checks).
// ────────────────────────────────────────────────────────────────────────────

/** SPEC §6.6 `subject_kind`: which class of principal a `model_entitlement` grants to. */
export const POLICY_SUBJECT_KINDS = [
  "key_scope",
  "team",
  "cost_center",
  "app",
  "all",
] as const;
export type PolicySubjectKind = (typeof POLICY_SUBJECT_KINDS)[number];

/** SPEC §6.6 `effect`: whether an entitlement allows or denies. */
export const POLICY_EFFECTS = ["allow", "deny"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/** SPEC §6.6 `on_violation`: what a `request_constraint` does when a param is out of bounds. */
export const POLICY_ON_VIOLATIONS = ["clamp", "reject"] as const;
export type PolicyOnViolation = (typeof POLICY_ON_VIOLATIONS)[number];

/** OpenAI-shaped data-plane error envelope (SPEC §0.3). */
export const GatewayError = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable().optional(),
    code: z.string(),
  }).strict(),
}).strict();
export type GatewayError = z.infer<typeof GatewayError>;

/** Manifold control-plane error envelope (SPEC §0.3). */
export const ControlPlaneError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    reason_codes: z.array(ReasonCode).default([]),
    remediation: z.string().optional(),
    request_id: z.string(),
    schema: z.literal(SCHEMA_VERSION),
    retryable: z.boolean().default(false),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict();
export type ControlPlaneError = z.infer<typeof ControlPlaneError>;

/** Health payload returned by GET /api/v1/health (SPEC §18.5). */
export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  schema: z.literal(SCHEMA_VERSION),
  time: z.string(),
  checks: z.object({
    db: z.enum(["ok", "skipped", "unreachable"]),
    snapshot_store: z.enum(["ok", "skipped", "unreachable"]),
  }),
  ingest_lag_seconds: z.number().nullable(),
  storage_tier: z
    .enum(["normal", "warning", "high", "critical", "emergency"])
    .nullable(),
}).strict();
export type HealthResponse = z.infer<typeof HealthResponse>;

// ────────────────────────────────────────────────────────────────────────────
// Control-plane HTTP contracts. These schemas are deliberately wire-shaped:
// camelCase is retained where the control plane already exposes it, and every
// object is strict so an accidental response-field addition is a contract
// change rather than a silent drift.
// ────────────────────────────────────────────────────────────────────────────

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(JsonValue)]),
);
const NullableString = z.string().nullable();
const Cursor = z.string().nullable();

export const SessionLoginResponse = z.object({
  member: z.object({ id: z.string(), email: z.string(), name: z.string().nullable(), role: z.string() }).strict(),
  role: z.string(),
  expiresAt: z.string(),
}).strict();
export const SessionLogoutResponse = z.object({ loggedOut: z.literal(true) }).strict();

export const CliAuthorizationStartRequest = z.object({
  workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/i),
  clientId: z.string(),
  scopes: z.array(z.string()),
}).strict();
export const CliAuthorizationStartResponse = z.object({
  deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number(),
  expiresIn: z.number(), client: z.string(),
}).strict();
export const CliAuthorizationPollRequest = z.object({
  deviceCode: z.string().regex(/^mfd_[A-Za-z0-9_-]{32,}$/),
}).strict();
export const CliAuthorizationPollResponse = z.union([
  z.object({ status: z.enum(["authorization_pending", "slow_down"]), interval: z.number() }).strict(),
  z.object({ status: z.enum(["denied", "expired"]) }).strict(),
  z.object({ status: z.literal("approved"), accessToken: z.string(), tokenType: z.literal("Bearer"), scopes: z.array(z.string()) }).strict(),
]);

const Workspace = z.object({ id: z.string(), slug: z.string(), name: z.string(), region: z.string() }).strict();
const Page = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item), nextCursor: Cursor }).strict();
const Team = z.object({ id: z.string(), slug: z.string(), name: z.string(), costCenterId: NullableString, createdAt: z.string() }).strict();
const CostCenter = z.object({ id: z.string(), slug: z.string(), name: z.string(), parentId: NullableString, createdAt: z.string() }).strict();

export const TeamsResponse = Page(Team);
export const CostCentersResponse = Page(CostCenter);
export const AppsResponse = Page(z.object({
  id: z.string(), slug: z.string(), name: z.string(), status: z.string(), defaultCapturePolicy: JsonValue,
  createdAt: z.string(), actions: z.array(z.object({ id: z.string(), slug: z.string(), name: NullableString, source: z.string(), createdAt: z.string() }).strict()),
}).strict());
export const MeResponse = z.object({
  member: z.object({ id: z.string(), email: z.string(), role: z.string() }).strict().nullable(),
  role: z.string().nullable(), workspace: Workspace.nullable(), scopes: z.array(z.string()),
  availableIngressProfiles: z.array(z.object({ id: z.string(), installationId: z.string(), installationName: z.string(), hostname: z.string(), mode: z.string(), networkExposure: z.string() }).strict()),
  sessionExpiresAt: z.string().nullable(),
}).strict();
export const ContextResponse = z.object({
  workspace: Workspace.nullable(),
  installations: z.array(z.object({ id: z.string(), name: z.string(), edition: z.string(), lastSeenAt: z.string().nullable(), status: z.enum(["active", "disabled"]), profiles: z.array(z.object({ id: z.string(), hostname: z.string(), mode: z.string(), networkExposure: z.string(), available: z.boolean(), status: z.enum(["active", "disabled"]) }).strict()) }).strict()),
  apps: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), status: z.string(), actions: z.array(z.object({ id: z.string(), slug: z.string(), name: NullableString, source: z.string() }).strict()) }).strict()),
  teams: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), costCenterId: NullableString }).strict()),
  costCenters: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), parentId: NullableString }).strict()),
  profileAvailability: z.array(z.object({ profileId: z.string(), installationId: z.string(), available: z.boolean() }).strict()),
}).strict();

/** Families currently exposed beneath /api/v1; route seams use the named exports above. */
export const ControlPlaneContractFamilies = [
  "health", "session", "cli-auth", "identity", "registry", "providers", "routes", "profiles",
  "policies", "config", "installations", "deployments", "keys", "budgets", "observations",
  "usage", "storage", "audit", "settings", "apps", "teams", "cost-centers", "context",
] as const;

// The remaining endpoint families use these reusable, strict envelopes. Their `data` payloads
// remain JSON values because each endpoint has a distinct projection; a route chooses the
// appropriate envelope and a payload schema when it is adopted at the HTTP seam.
export const EmptyRequest = z.object({}).strict();
export const DataResponse = z.object({ data: JsonValue }).strict();
export const CursorResponse = z.object({ data: z.array(JsonValue), nextCursor: Cursor }).strict();
export const StatusResponse = z.object({ status: z.string() }).strict();
export const IdResponse = z.object({ id: z.string() }).strict();
export const InternalResponse = z.object({ ok: z.boolean() }).strict();

const NonEmptyString = z.string().min(1);
const OptionalNullableString = z.string().nullable().optional();
const JsonObject = z.record(JsonValue);

export const RegistryContracts = {
  createOverride: z.object({ offeringId: NonEmptyString, inputPerMtokMicrousd: OptionalNullableString, outputPerMtokMicrousd: OptionalNullableString, cacheReadPerMtokMicrousd: OptionalNullableString, cacheWritePerMtokMicrousd: OptionalNullableString, reasoningPerMtokMicrousd: OptionalNullableString, audioInPerMtokMicrousd: OptionalNullableString, audioOutPerMtokMicrousd: OptionalNullableString }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse]),
} as const;
export const ProviderContracts = {
  create: z.object({ provider: NonEmptyString, label: z.string().optional(), secret: NonEmptyString, baseUrl: z.string().url().optional(), allowedHosts: z.array(z.string()).optional() }).strict(),
  rotate: z.object({ secret: NonEmptyString }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
export const RouteContracts = {
  create: z.object({ installationId: NonEmptyString, publicName: NonEmptyString, endpointKind: NonEmptyString, target: JsonObject.optional(), targets: z.array(JsonObject).optional(), mode: z.string().optional(), retryPolicy: JsonObject.optional(), timeoutPolicy: JsonObject.optional(), capturePolicy: JsonObject.optional() }).strict(),
  test: z.object({ profileId: NonEmptyString }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
const ProfileListResponse = z.object({ data: z.array(JsonValue), nextCursor: Cursor, trustedHostInvariant: z.string() }).strict();
const ProfileDetailResponse = z.object({
  id: z.string(), installationId: z.string(), hostname: z.string(), mode: z.string(), networkExposure: z.string(),
  authConfig: JsonValue, networkConfig: JsonValue, policyRevisionId: z.string().nullable(), defaultRouteSet: JsonValue,
  published: z.boolean(), bindingStatus: z.enum(["published", "draft"]), available: z.boolean(), status: z.enum(["active", "disabled"]),
  trustedHostInvariant: z.string(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
const ProfileDisableResponse = z.object({ id: z.string(), status: z.literal("disabled"), disabledAt: z.string(), unpublishedChanges: z.number() }).strict();
export const ProfileContracts = { disable: EmptyRequest, list: ProfileListResponse, detail: ProfileDetailResponse, disableResponse: ProfileDisableResponse, response: z.union([ProfileListResponse, ProfileDetailResponse, ProfileDisableResponse]) } as const;
export const PolicyContracts = {
  create: z.object({ name: NonEmptyString }).strict(),
  approve: z.object({ expectedRevisionId: NonEmptyString }).strict(),
  simulate: z.object({ revisionId: NonEmptyString.optional(), subject: JsonObject, canonicalModelId: NonEmptyString, params: JsonObject.optional() }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;

// Governance endpoints deliberately use route-specific schemas.  The projections include
// nested database JSON, but the surrounding wire shape remains closed at every level.
const Id = z.string().min(1);
const StringRecord = z.record(z.string(), z.string());
const PolicyListItem = z.object({ id: Id, name: z.string(), activeRevisionId: z.string().nullable(), revisionCount: z.number().int(), createdAt: z.string(), updatedAt: z.string() }).strict();
const PolicyEntitlement = z.object({ id: Id, subjectKind: z.enum(POLICY_SUBJECT_KINDS), subjectRef: z.string().nullable(), canonicalModelId: z.string().nullable(), offeringId: z.string().nullable(), effect: z.enum(POLICY_EFFECTS), createdAt: z.string() }).strict();
const PolicyConstraint = z.object({ id: Id, param: z.string(), maxValue: z.number().nullable(), minValue: z.number().nullable(), onViolation: z.enum(POLICY_ON_VIOLATIONS), createdAt: z.string() }).strict();
const PolicyRevision = z.object({ id: Id, contentHash: z.string(), createdBy: z.string().nullable(), createdAt: z.string(), isActive: z.boolean(), entitlements: z.array(PolicyEntitlement), requestConstraints: z.array(PolicyConstraint), dataHandlingConstraints: z.array(z.object({ id: Id, captureMode: z.string(), redaction: JsonValue, allowedRegions: JsonValue, createdAt: z.string() }).strict()), approvals: z.array(z.object({ id: Id, approvedBy: Id, reason: z.string().nullable(), createdAt: z.string() }).strict()) }).strict();
export const PolicyEndpointContracts = {
  list: z.object({ data: z.array(PolicyListItem), nextCursor: Cursor }).strict(),
  create: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
  createResponse: z.object({ id: Id, name: z.string(), status: z.literal("draft"), publishRequired: z.literal(true) }).strict(),
  detail: z.object({ id: Id, name: z.string(), activeRevisionId: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), revisions: z.array(PolicyRevision) }).strict(),
  revision: z.object({ entitlements: z.array(z.object({ subjectKind: z.enum(POLICY_SUBJECT_KINDS), subjectRef: z.string().nullable().optional(), canonicalModelId: z.string().nullable().optional(), offeringId: z.string().nullable().optional(), effect: z.enum(POLICY_EFFECTS).optional() }).strict()), requestConstraints: z.array(z.object({ param: z.string().min(1), maxValue: z.number().finite().nullable().optional(), minValue: z.number().finite().nullable().optional(), onViolation: z.enum(POLICY_ON_VIOLATIONS).optional() }).strict()), dataHandlingConstraints: z.array(z.object({ captureMode: z.enum(["none", "metadata", "redacted", "full"]).optional(), redaction: z.record(JsonValue).nullable().optional(), allowedRegions: z.array(z.string().min(1)).nullable().optional() }).strict()) }).strict(),
  revisionResponse: z.object({ policyId: Id, revisionId: Id, contentHash: z.string(), status: z.literal("staged"), publishRequired: z.literal(true) }).strict(),
  approve: z.object({ revisionId: Id, reason: z.string().min(1).optional() }).strict(),
  approveResponse: z.object({ policyId: Id, revisionId: Id, approvalId: Id, status: z.literal("approved") }).strict(),
  simulate: z.object({ revisionId: Id, subject: z.object({ keyScope: Id.optional(), team: Id.optional(), costCenter: Id.optional(), app: Id.optional() }).strict(), canonicalModelId: Id, params: z.record(z.string(), z.number().finite()) }).strict(),
  simulateResponse: z.object({ policyId: Id, revisionId: Id, outcome: z.string(), reasonCodes: z.array(z.string()), clamps: z.record(z.string(), z.number()) }).strict(),
} as const;

const BudgetScope = z.object({ type: z.enum(["workspace", "team", "app", "cost_center", "key"]), id: z.string().nullable() }).strict();
const BudgetBurn = z.union([
  z.object({ model: z.literal("linear_window_run_rate"), status: z.literal("available"), currentAmount: z.string(), forecastAmount: z.string(), limitAmount: z.string(), windowStart: z.string(), windowEnd: z.string(), burnRatePerDay: z.string() }).strict(),
  z.object({ model: z.literal("linear_window_run_rate"), status: z.literal("unavailable"), currentAmount: z.string(), forecastAmount: z.null(), reason: z.string() }).strict(),
]);
const BudgetView = z.object({ id: Id, scope: BudgetScope, parentId: z.string().nullable(), unit: z.enum(["cost_microusd", "tokens"]), currency: z.string(), window: z.string(), limitAmount: z.string(), enforcement: z.enum(["advisory", "hard"]), pricingCatalogRevisionId: z.string().nullable(), counters: z.object({ committed: z.string(), reserved: z.string(), current: z.string() }).strict(), overBudget: z.boolean(), status: z.enum(["staged", "disabled"]), publishRequired: z.boolean(), burn: BudgetBurn, createdAt: z.string(), updatedAt: z.string() }).strict();
export const BudgetEndpointContracts = {
  create: z.object({ scopeType: BudgetScope.shape.type, scopeId: z.string().nullable().optional(), parentId: z.string().nullable().optional(), unit: z.enum(["cost_microusd", "tokens"]), currency: z.string(), window: z.string(), limitAmount: z.union([z.string(), z.number()]), enforcement: z.enum(["advisory", "hard"]), pricingCatalogRevisionId: z.string().nullable().optional() }).strict(),
  list: z.object({ data: z.array(BudgetView), nextCursor: Cursor }).strict(),
  created: z.union([BudgetView.extend({ created: z.literal(false) }).strict(), z.object({ id: Id, status: z.literal("staged"), publishRequired: z.literal(true), activeEnforcement: z.literal(false) }).strict()]),
  detail: BudgetView.extend({ allocations: z.array(z.object({ id: Id, parentId: Id, childId: Id, childScope: BudgetScope, reservedAllowance: z.string(), window: z.string(), createdAt: z.string() }).strict()), reservations: z.array(z.object({ id: Id, requestId: z.string(), estimatedInputTokens: z.string(), maxOutputTokens: z.string(), reservedMicrousd: z.string(), reservedTokens: z.string().nullable(), status: z.string(), reconciledMicrousd: z.string().nullable(), reconciledTokens: z.string().nullable(), expiresAt: z.string(), createdAt: z.string(), reconciledAt: z.string().nullable() }).strict()), alerts: z.array(z.object({ id: Id, scope: BudgetScope, metric: z.string(), threshold: z.string(), window: z.string(), destinations: JsonValue, status: z.enum(["active", "disabled"]), createdAt: z.string() }).strict()) }).strict(),
  allocate: z.object({ childId: Id, reservedAllowance: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]) }).strict(),
  allocationResponse: z.object({ id: Id, parentId: Id, childId: Id, reservedAllowance: z.string(), status: z.literal("staged"), publishRequired: z.literal(true), activeEnforcement: z.literal(false).optional(), created: z.literal(false).optional() }).strict(),
  forecast: z.intersection(z.object({ budgetId: Id, unit: z.enum(["cost_microusd", "tokens"]), counters: z.object({ committed: z.string(), reserved: z.string(), current: z.string() }).strict() }).strict(), BudgetBurn),
} as const;
export const ConfigContracts = {
  apply: z.object({ installationId: NonEmptyString, planHash: NonEmptyString, approvalIds: z.array(NonEmptyString).optional() }).strict(),
  plan: z.object({ installationId: NonEmptyString }).strict(),
  planQuery: z.object({ installationId: NonEmptyString }).strict(),
  activeQuery: z.object({ installationId: NonEmptyString }).strict(),
  approval: z.object({ installationId: NonEmptyString, planHash: NonEmptyString }).strict(),
  rollback: z.object({ installationId: NonEmptyString, revisionId: NonEmptyString, baseConfigHash: NonEmptyString }).strict(),
  reconcile: z.object({ operationId: NonEmptyString }).strict(),
  planResponse: z.object({ installationId: z.string(), planHash: z.string(), baseConfigHash: z.string().nullable(), targetConfigHash: z.string(), diff: JsonValue, tripwireItems: z.array(JsonValue), noop: z.boolean() }).strict(),
  applyResponse: z.object({ revisionId: z.string(), edgeConfigVersion: z.string().nullable(), servingMode: z.enum(["boot_fallback", "edge_config"]), acceleratorStatus: z.string(), activeContentHash: z.string(), outcome: z.string(), noop: z.boolean() }).strict(),
  rollbackResponse: z.object({ operationId: z.string(), revisionId: z.string(), activeContentHash: z.string(), servingMode: z.enum(["boot_fallback", "edge_config"]), acceleratorStatus: z.string(), edgeConfigVersion: z.string().nullable(), byteIdentical: z.literal(true) }).strict(),
  approvalResponse: z.object({ installationId: z.string(), planHash: z.string(), approvals: z.array(z.object({ id: z.string(), kind: z.string(), ref: z.string() }).strict()), expiresAt: z.string() }).strict(),
  reconcileResponse: z.object({ operationId: z.string(), revisionId: z.string(), servingMode: z.enum(["boot_fallback", "edge_config"]), acceleratorStatus: z.string(), edgeConfigVersion: z.string().nullable() }).strict(),
  historyQuery: z.object({ installationId: NonEmptyString }).strict(),
  historyResponse: z.object({ installationId: z.string(), revisions: z.array(z.object({ id: z.string(), content_hash: z.string(), parent_revision_id: z.string().nullable(), status: z.string(), created_by: z.string().nullable(), created_at: z.string() }).strict()), operations: z.array(z.object({ id: z.string(), operation_kind: z.string(), revision_id: z.string().nullable(), base_config_hash: z.string().nullable(), target_config_hash: z.string().nullable(), plan_hash: z.string().nullable(), diff_json: JsonValue, outcome: z.string(), serving_mode: z.string().nullable(), accelerator_status: z.string().nullable(), edge_config_version: z.string().nullable(), tripwire_items: JsonValue, approved_by: JsonValue, error: JsonValue, reconciliation_attempts: z.number(), last_reconcile_at: z.string().nullable(), completed_at: z.string().nullable(), created_by: z.string().nullable(), created_at: z.string() }).strict()) }).strict(),
  response: z.union([DataResponse, IdResponse, StatusResponse]),
} as const;
export const InstallationContracts = {
  create: z.object({ name: NonEmptyString, edition: z.enum(["vercel", "cloudflare", "compose"]).optional(), publicKey: NonEmptyString.optional(), workloadIdentity: z.object({ issuer: z.string().url(), jwksUrl: z.string().url(), audience: NonEmptyString, subject: NonEmptyString }).strict().optional() }).strict(),
  update: z.object({ name: NonEmptyString.optional(), edition: z.enum(["vercel", "cloudflare", "compose"]).optional() }).strict().refine((value) => value.name !== undefined || value.edition !== undefined),
  heartbeat: z.object({ appliedConfigRevision: z.string().nullable().optional(), reportedAt: z.string().datetime().optional() }).strict(),
  heartbeatResponse: z.object({ installationId: z.string(), appliedConfigRevision: z.string().nullable(), observedAt: z.string() }).strict(),
  listQuery: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict(),
  empty: EmptyRequest,
  listItem: z.object({ id: z.string(), name: z.string(), edition: z.string(), appliedConfigRevision: z.string().nullable(), lastSeenAt: z.string().nullable(), status: z.enum(["active", "disabled"]), createdAt: z.string() }).strict(),
  listResponse: z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), edition: z.string(), appliedConfigRevision: z.string().nullable(), lastSeenAt: z.string().nullable(), status: z.enum(["active", "disabled"]), createdAt: z.string() }).strict()), nextCursor: z.string().nullable() }).strict(),
  createResponse: z.object({ id: z.string(), name: z.string(), edition: z.string(), status: z.literal("active"), installationIdentityPublicKey: z.string().optional(), installationIdentityPrivateKey: z.string().optional(), privateKeyShownOnce: z.literal(true).optional() }).strict(),
  detailResponse: z.object({ id: z.string(), name: z.string(), edition: z.string(), appliedConfigRevision: z.string().nullable(), activeConfigRevision: z.string().nullable(), lastSeenAt: z.string().nullable(), status: z.enum(["active", "disabled"]), createdAt: z.string(), trustedHostInvariant: z.string(), profiles: z.array(z.object({ id: z.string(), hostname: z.string(), mode: z.string(), networkExposure: z.string(), authConfig: JsonValue, networkConfig: JsonValue.nullable(), policyRevisionId: z.string().nullable(), defaultRouteSet: JsonValue.nullable(), published: z.boolean(), bindingStatus: z.enum(["published", "draft"]), available: z.boolean(), status: z.enum(["active", "disabled"]), trustedHostInvariant: z.string(), createdAt: z.string() }).strict()) }).strict(),
  updateResponse: z.object({ id: z.string(), name: z.string(), edition: z.string(), status: z.enum(["active", "disabled"]), updatedAt: z.string() }).strict(),
  disableResponse: z.object({ id: z.string(), status: z.literal("disabled"), disabledAt: z.string() }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
export const DeploymentContracts = {
  listQuery: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict(),
  diagnosticsQuery: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict(),
  profile: z.object({ hostname: NonEmptyString, mode: z.enum(["public_app", "enterprise_egress"]), networkExposure: z.enum(["public", "vpc", "mtls"]), authConfig: JsonValue, networkConfig: JsonValue.nullable().optional(), policyRevisionId: z.string().nullable().optional(), defaultRouteSet: z.array(NonEmptyString).nullable().optional() }).strict(),
  profileResponse: z.object({ id: z.string(), installationId: z.string(), hostname: z.string(), mode: z.string(), networkExposure: z.string(), authConfig: JsonValue, networkConfig: JsonValue.nullable(), policyRevisionId: z.string().nullable(), defaultRouteSet: JsonValue.nullable(), status: z.literal("draft"), published: z.literal(false), bindingEffective: z.literal(false), unpublishedChanges: z.number(), trustedHostInvariant: z.string() }).strict(),
  diagnosticsResponse: z.object({ installationId: z.string(), lastHeartbeat: z.object({ observedAt: z.string().nullable(), appliedConfigRevision: z.string().nullable(), installationStatus: z.enum(["active", "disabled"]), reportingAvailable: z.literal(true) }).strict(), recentConfigOperations: z.array(z.object({ id: z.string(), outcome: z.string(), baseConfigHash: z.string().nullable(), targetConfigHash: z.string().nullable(), planHash: z.string().nullable(), edgeConfigVersion: z.string().nullable(), tripwireItems: JsonValue, error: JsonValue, createdAt: z.string() }).strict()), syntheticTest: z.object({ available: z.boolean(), lastResult: z.object({ id: z.string(), createdAt: z.string(), detail: JsonValue }).strict().nullable(), reason: z.string() }).strict() }).strict(),
  readinessResponse: z.object({ installationId: z.string(), ready: z.boolean(), checks: JsonValue }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
export const KeyContracts = {
  mint: z.object({ profileId: NonEmptyString, scopes: z.array(z.string()).optional(), allowedAppIds: z.array(z.string()).optional(), defaultAppId: OptionalNullableString, defaultActionId: OptionalNullableString, teamId: OptionalNullableString, costCenterId: OptionalNullableString, budgetAccountId: OptionalNullableString, rateLimit: JsonObject.optional(), expiresAt: OptionalNullableString }).strict(),
  rotate: z.object({ graceSeconds: z.number().int().nonnegative().optional() }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
export const BudgetContracts = {
  create: z.object({ name: NonEmptyString, period: z.string(), limitMicrousd: z.string(), costCenterId: OptionalNullableString, teamId: OptionalNullableString }).strict(),
  allocate: z.object({ amountMicrousd: z.string(), subjectKind: NonEmptyString, subjectId: NonEmptyString }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
// Observability is consumed directly by the console and CLI, so its schemas are
// intentionally complete rather than falling back to the generic JSON envelopes.
const IntegerString = z.string().regex(/^\d+$/, "expected a base-10 integer string");
const IsoTimestamp = z.string().datetime({ offset: true });
// Empty query values are a historical spelling of an omitted optional filter;
// semantic normalization remains in the route parser.
const OptionalQueryString = z.string().max(256).optional();
const ObservationFilterQuery = z.object({
  from: OptionalQueryString, start: OptionalQueryString, to: OptionalQueryString, end: OptionalQueryString,
  range: OptionalQueryString, profile: OptionalQueryString, profile_mode: OptionalQueryString, profileMode: OptionalQueryString,
  route: OptionalQueryString, route_id: OptionalQueryString, routeId: OptionalQueryString,
  model: OptionalQueryString, model_id: OptionalQueryString, modelId: OptionalQueryString, provider: OptionalQueryString,
  status: z.enum(["ok", "error", "denied", "clamped", "timeout", ""]).optional(),
  app: OptionalQueryString, app_id: OptionalQueryString, appId: OptionalQueryString,
  action: OptionalQueryString, action_id: OptionalQueryString, actionId: OptionalQueryString,
  key: OptionalQueryString, key_id: OptionalQueryString, keyId: OptionalQueryString,
  cost_center: OptionalQueryString, costCenter: OptionalQueryString, cost_center_id: OptionalQueryString, costCenterId: OptionalQueryString,
  min_latency_ms: z.string().regex(/^(?:\d+)?$/).optional(), minLatencyMs: z.string().regex(/^(?:\d+)?$/).optional(), min_latency: z.string().regex(/^(?:\d+)?$/).optional(),
  errors_only: z.enum(["true", "false", "1", "0", ""]).optional(), errorsOnly: z.enum(["true", "false", "1", "0", ""]).optional(), errors: z.enum(["true", "false", "1", "0", ""]).optional(),
  trace: OptionalQueryString, q: OptionalQueryString, trace_id: OptionalQueryString, traceId: OptionalQueryString,
}).strict();
const ObservationListQuery = ObservationFilterQuery.extend({ limit: z.string().regex(/^(?:\d+)?$/).optional(), cursor: OptionalQueryString }).strict();
const UsageQuery = ObservationFilterQuery.extend({
  limit: z.string().regex(/^(?:\d+)?$/).optional(), cursor: OptionalQueryString,
  grain: z.enum(["hourly", "daily", "monthly"]).optional(),
  dimension: z.enum(["route", "provider", "app", "team", "cost_center", "model", "status", "profile"]).optional(),
  dimension_value: OptionalQueryString, dimensionValue: OptionalQueryString,
}).strict();
const ObservationItem = z.object({
  id: z.string(), trace_id: z.string(), installation_id: z.string(), profile_mode: z.string(),
  route: z.object({ id: z.string().nullable(), public_name: z.string().nullable(), endpoint_kind: z.string().nullable() }).strict(),
  model: z.object({ offering_id: z.string().nullable(), canonical_model_id: z.string().nullable(), canonical_slug: z.string().nullable(), provider_model_id: z.string().nullable() }).strict(),
  provider: z.string().nullable(), app: z.object({ id: z.string().nullable(), slug: z.string().nullable() }).strict(),
  action: z.object({ id: z.string().nullable(), slug: z.string().nullable() }).strict(), team_id: z.string().nullable(),
  cost_center: z.object({ id: z.string().nullable(), slug: z.string().nullable() }).strict(),
  key: z.object({ id: z.string().nullable(), display_prefix: z.string().nullable() }).strict(), status: z.string(), http_status: z.number().int().nullable(),
  usage: z.object({ input_tokens: IntegerString.nullable(), output_tokens: IntegerString.nullable(), cache_read_tokens: IntegerString.nullable(), reasoning_tokens: IntegerString.nullable(), cache_write_tokens: IntegerString.nullable(), audio_input_tokens: IntegerString.nullable(), audio_output_tokens: IntegerString.nullable() }).strict(),
  cost: z.object({ amount_microusd: IntegerString.nullable(), fidelity: z.string() }).strict(), latency_ms: z.number().nullable(), ttfb_ms: z.number().nullable(), attempts: z.number().int(), failovers: z.number().int(), reason_codes: z.array(z.string()), compacted: z.boolean(), occurred_at: IsoTimestamp, created_at: IsoTimestamp,
}).strict();
const ObservationListResponse = z.object({ data: z.array(ObservationItem), next_cursor: z.string().nullable(), ingest_lag_seconds: z.number().nullable() }).strict();
const ObservationSummaryResponse = z.object({ sample_count: IntegerString, p50_ms: z.number().nullable(), p95_ms: z.number().nullable() }).strict();
const DetailState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("full"), detail_compacted: z.literal(false), compacted_at: IsoTimestamp.nullable(), note: z.null() }).strict(),
  z.object({ state: z.literal("compacted"), detail_compacted: z.literal(true), compacted_at: IsoTimestamp.nullable(), note: z.string() }).strict(),
  z.object({ state: z.literal("unavailable"), detail_compacted: z.literal(false), compacted_at: IsoTimestamp.nullable(), note: z.string() }).strict(),
]);
const Capture = z.object({
  policy: z.object({ name: z.string(), source: z.enum(["route_revision", "app", "data_handling"]), mode: z.enum(["none", "metadata", "redacted", "full"]), max_bytes: z.number().int().nonnegative() }).strict(),
  metadata: z.object({ present: z.boolean(), stored_bytes: z.number().nullable(), truncated: z.boolean(), redacted: z.boolean(), sampled_out: z.boolean(), response_bound_exceeded: z.boolean().optional() }).strict(),
  payload: z.object({ request: JsonValue.nullable(), response: JsonValue.nullable() }).strict().nullable(),
  visibility: z.enum(["scope_required", "not_captured", "policy_disallows_payload", "bounded_out", "visible"]),
}).strict();
const Span = z.object({ id: z.string(), parent_span_id: z.string().nullable(), kind: z.string(), seq: z.number().int(), occurred_at: IsoTimestamp, duration_ms: z.number().nullable(), provider: z.object({ name: z.string().nullable(), offering_id: z.string().nullable(), provider_model_id: z.string().nullable(), adapter_revision: z.string().nullable() }).strict().nullable(), detail: z.record(JsonValue) }).strict();
const ObservationDetailResponse = z.object({
  trace_id: z.string(), detail_state: DetailState, observation: ObservationItem.nullable(),
  summary: z.object({ root_observation_id: z.string(), span_count: z.number().int(), error: z.boolean(), total_cost_microusd: IntegerString.nullable(), total_latency_ms: z.number().nullable(), started_at: IsoTimestamp }).strict().nullable(),
  spans: z.array(Span), attempts: z.array(Span),
  usage: z.object({ input_tokens: IntegerString.nullable(), output_tokens: IntegerString.nullable(), cache_read_tokens: IntegerString.nullable(), reasoning_tokens: IntegerString.nullable(), cache_write_tokens: IntegerString.nullable(), audio_input_tokens: IntegerString.nullable(), audio_output_tokens: IntegerString.nullable(), fidelity: z.string() }).strict(),
  cost: z.object({ amount_microusd: IntegerString.nullable(), fidelity: z.string(), price_revision_id: z.string().nullable() }).strict(), capture: Capture,
  policy_decisions: z.array(z.object({ id: z.string(), request_id: z.string(), outcome: z.string(), reason_codes: z.array(z.string()), policy_revision_id: z.string().nullable(), created_at: IsoTimestamp }).strict()),
  annotations: z.array(z.object({ id: z.string(), author_id: z.string().nullable(), body: z.string().nullable(), tags: z.array(z.string()), updated_at: IsoTimestamp, created_at: IsoTimestamp }).strict()),
  feedback: z.array(z.object({ id: z.string(), score: z.string().nullable(), label: z.string().nullable(), source: z.string().nullable(), created_at: IsoTimestamp }).strict()),
  audit: z.object({ id: z.string(), action: z.string(), request_ref: z.string().nullable(), created_at: IsoTimestamp, href: z.string() }).strict().nullable(),
}).strict();
const AnnotationRequest = z.object({ body: z.string().nullable().optional(), tags: z.array(z.string()).max(20).optional() }).strict();
const AnnotationResponse = z.object({ id: z.string(), trace_id: z.string(), author_id: z.string(), body: z.string().nullable(), tags: z.array(z.string()), created_at: IsoTimestamp, updated_at: IsoTimestamp }).strict();
const FeedbackRequest = z.object({ score: z.number().finite().min(-1).max(1).nullable().optional(), label: z.string().nullable().optional() }).strict();
const FeedbackResponse = z.object({ id: z.string(), trace_id: z.string(), score: z.string().nullable(), label: z.string().nullable(), source: z.string(), created_at: IsoTimestamp }).strict();
const UsageResponse = z.object({
  data: z.array(z.object({ grain: z.enum(["hourly", "daily", "monthly"]), bucket_start: IsoTimestamp, dimension: z.enum(["route", "provider", "app", "team", "cost_center", "model", "status", "profile"]), dimension_value: z.string().nullable(), dims: z.record(z.string().nullable()), requests: IntegerString, input_tokens: IntegerString, output_tokens: IntegerString, cache_read_tokens: IntegerString, reasoning_tokens: IntegerString, cost_microusd: IntegerString, errors: IntegerString, failovers: IntegerString, latency_ms_sum: IntegerString, latency_ms_p95: z.number().nullable(), updated_at: IsoTimestamp }).strict()),
  next_cursor: z.string().nullable(), compaction_boundary_note: z.object({ requested_grain: z.enum(["hourly", "daily", "monthly"]), fallback_grain: z.enum(["daily", "monthly"]).nullable(), boundary: IsoTimestamp.nullable(), message: z.string() }).strict().nullable(),
}).strict();
export const ObservationContracts = {
  listQuery: ObservationListQuery, summaryQuery: ObservationFilterQuery, detailParams: z.object({ traceId: z.string().min(1).max(256) }).strict(),
  annotation: AnnotationRequest, feedback: FeedbackRequest, export: z.union([ObservationFilterQuery, z.object({ filters: ObservationFilterQuery }).strict()]),
  list: ObservationListResponse, summary: ObservationSummaryResponse, detail: ObservationDetailResponse, annotationResponse: AnnotationResponse, feedbackResponse: FeedbackResponse,
  jsonlLine: ObservationItem, response: z.union([ObservationListResponse, ObservationSummaryResponse, ObservationDetailResponse, AnnotationResponse, FeedbackResponse]),
} as const;
export const UsageContracts = { query: UsageQuery, response: UsageResponse } as const;

// Installation-authenticated ingest is a public write boundary.  Keep this
// deliberately smaller than the internal journal projection: tenant and
// producer identity are derived from the authenticated installation, never
// accepted from the producer payload.
const IngestId = z.string().trim().min(1).max(256);
const IngestUsage = z.object({
  inputTokens: z.number().int().nonnegative().safe().optional(),
  outputTokens: z.number().int().nonnegative().safe().optional(),
  cacheReadTokens: z.number().int().nonnegative().safe().optional(),
  reasoningTokens: z.number().int().nonnegative().safe().optional(),
  cacheWriteTokens: z.number().int().nonnegative().safe().optional(),
  audioInputTokens: z.number().int().nonnegative().safe().optional(),
  audioOutputTokens: z.number().int().nonnegative().safe().optional(),
}).strict();
const IngestPrice = z.object({
  inputPerMtokMicroUsd: IntegerString.nullable().optional(),
  outputPerMtokMicroUsd: IntegerString.nullable().optional(),
  cacheReadPerMtokMicroUsd: IntegerString.nullable().optional(),
  cacheWritePerMtokMicroUsd: IntegerString.nullable().optional(),
  reasoningPerMtokMicroUsd: IntegerString.nullable().optional(),
  audioInPerMtokMicroUsd: IntegerString.nullable().optional(),
  audioOutPerMtokMicroUsd: IntegerString.nullable().optional(),
}).strict();
const IngestCapture = z.object({
  mode: z.enum(["redacted", "full"]),
  request: z.record(JsonValue).optional(),
  response: z.record(JsonValue).optional(),
  truncated: z.boolean().optional(),
  bytes: z.number().int().nonnegative().max(4_096),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4_096) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "capture exceeds the 4096-byte transport cap" });
  }
});
const IngestEvent = z.object({
  traceId: IngestId,
  kind: z.enum(["accepted", "provider_attempt", "terminal"]),
  seq: z.number().int().nonnegative().safe(),
  occurredAt: IsoTimestamp,
  profileId: IngestId,
  keyId: IngestId.nullable(),
  routeId: IngestId.nullable(),
  offeringId: IngestId.nullable(),
  status: z.number().int().min(0).max(999).nullable(),
  reasonCodes: z.array(ReasonCode).max(64),
  usage: IngestUsage.optional(),
  price: IngestPrice.optional(),
  priceRevisionId: IngestId.nullable().optional(),
  budgetAccountId: IngestId.nullable().optional(),
  reservationId: IngestId.nullable().optional(),
  /** Gateway-originated bounded tee envelope; top-level schema is closed. */
  capture: IngestCapture.optional(),
}).strict();
const ProviderAttemptIngestEvent = IngestEvent.extend({
  kind: z.literal("provider_attempt"),
  targetId: IngestId,
  routeRevisionId: IngestId,
  snapshotRevision: IngestId,
  attemptOutcome: z.enum(["success", "transient_failure", "permanent_failure"]),
}).strict();
const NonProviderAttemptIngestEvent = IngestEvent.extend({
  kind: z.enum(["accepted", "terminal"]),
}).strict();
const ObservationIngestErrorResponse = z.object({
  error: z.object({
    code: z.enum(["VALIDATION", "UNAUTHENTICATED", "FORBIDDEN", "INTERNAL"]),
    message: z.string(),
    reason_codes: z.array(z.union([ReasonCode, z.enum(["OBSERVATION_INGEST_INVALID", "OBSERVATION_INGEST_BATCH_TOO_LARGE", "OBSERVATION_INGEST_CALLER_IDENTITY_FORBIDDEN"])])),
    remediation: z.string().optional(), request_id: z.string(), schema: z.literal(SCHEMA_VERSION), retryable: z.boolean(), details: z.record(z.unknown()).optional(),
  }).strict(),
}).strict();
export const ObservationIngestContracts = {
  batch: z.object({ events: z.array(z.union([ProviderAttemptIngestEvent, NonProviderAttemptIngestEvent])).min(1).max(100) }).strict(),
  accepted: z.object({ accepted: z.number().int().min(1).max(100), projected: z.number().int().min(0).max(100) }).strict(),
  error: ObservationIngestErrorResponse,
} as const;
export const StorageContracts = {
  retentionQuery: z.object({}).strict(),
  retentionRequest: z.object({ observationRetentionDays: z.number().int().min(1).max(3650), exportTarget: z.enum(["disabled", "local_filesystem", "object_storage"]), exportLocation: z.string().min(1).optional(), enabled: z.boolean() }).strict(),
  retentionResponse: z.object({ configured: z.boolean(), observationRetentionDays: z.number().int().min(1).max(3650).nullable(), exportTarget: z.enum(["disabled", "local_filesystem", "object_storage"]), exportConfigured: z.boolean(), destructiveDeletion: z.enum(["eligible_after_verified_export", "blocked"]), remediation: z.string().nullable(), updatedAt: z.string().optional() }).strict(),
  thresholds: z.object({ warnPct: z.number().int().min(1).max(100), highPct: z.number().int().min(1).max(100), critPct: z.number().int().min(1).max(100) }).strict().refine((value) => value.warnPct < value.highPct && value.highPct < value.critPct),
  compact: EmptyRequest,
  overviewResponse: z.object({ measuredAt: z.string().nullable(), usedBytes: z.string().nullable(), ceilingBytes: z.string().nullable(), usedPct: z.number().nullable(), tier: z.enum(["normal", "warning", "high", "critical", "emergency"]).nullable(), pressure: z.object({ captureMode: z.enum(["none", "metadata", "redacted", "full"]), payloadSampleRate: z.number().min(0).max(1), journalMode: z.enum(["full", "aggregate_only"]), source: z.enum(["persisted", "fallback"]) }).strict().nullable(), thresholds: z.object({ warnPct: z.number(), highPct: z.number(), critPct: z.number() }).strict().nullable(), tables: JsonValue.nullable(), indexesBytes: z.string().nullable(), toastBytes: z.string().nullable(), growthBytesPerDay: z.string().nullable(), forecastExhaustionAt: z.string().nullable(), retention: z.object({ available: z.literal(true), observationRetentionDays: z.number().nullable(), exportTarget: z.string(), exportConfigured: z.boolean(), enabled: z.boolean(), destructiveDeletion: z.enum(["eligible_after_verified_export", "blocked"]), checkpoints: z.record(z.number()) }).strict(), lastCompaction: z.object({ id: z.string(), status: z.string(), queuedAt: z.string().nullable(), updatedAt: z.string(), error: JsonValue, freedBytes: z.number().nullable(), progress: JsonValue.nullable() }).strict().nullable() }).strict(),
  thresholdsResponse: z.object({ thresholds: z.object({ warnPct: z.number(), highPct: z.number(), critPct: z.number() }).strict(), ceilingBytes: z.string().nullable(), measuredAt: z.string().nullable(), usedPct: z.number().nullable(), tier: z.enum(["normal", "warning", "high", "critical", "emergency"]).nullable() }).strict(),
  compactResponse: z.object({ jobId: z.string(), status: z.literal("queued"), freedBytes: z.null() }).strict(),
  response: z.union([DataResponse, StatusResponse]),
} as const;
export const AuditContracts = {
  destination: z.object({ name: NonEmptyString, url: z.string().url(), secret: NonEmptyString.optional(), enabled: z.boolean().optional() }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
const AuditTarget = z.object({ kind: z.string().nullable(), id: z.string().nullable() }).strict();
const AuditEvent = z.object({
  id: Id, actor: z.object({ kind: z.string(), id: z.string().nullable() }).strict(), action: z.string(), target: AuditTarget.nullable(), hashes: z.object({ before: z.string().nullable(), after: z.string().nullable() }).strict(), outcome: z.string().nullable(),
  links: z.object({ requestRef: z.string().nullable(), profileId: z.string().nullable(), target: AuditTarget.nullable() }).strict(), createdAt: z.string(),
  chain: z.union([z.object({ version: z.literal(1), previousHash: z.string().nullable(), hash: z.string(), sealedAt: z.string() }).strict(), z.null()]),
  chainVerification: z.discriminatedUnion("status", [z.object({ status: z.literal("sealed"), reason: z.string() }).strict(), z.object({ status: z.literal("legacy_unsealed"), reason: z.string() }).strict()]),
  compaction: z.object({ status: z.literal("not_applicable") }).strict(),
}).strict();
const AuditTimelineItem = z.discriminatedUnion("kind", [
  AuditEvent.extend({ kind: z.literal("audit_event") }).strict(),
  z.object({ kind: z.literal("policy_decision"), id: Id, outcome: z.string(), reasonCodes: z.array(z.string()), target: AuditTarget.nullable(), links: z.object({ requestId: z.string(), traceId: z.string().nullable(), policyRevisionId: z.string().nullable(), subject: z.null(), model: z.null() }).strict(), createdAt: z.string() }).strict(),
]);
const AuditDestination = z.object({ id: Id, kind: z.enum(["webhook", "siem"]), label: z.string(), status: z.string(), createdAt: z.string(), updatedAt: z.string(), endpoint: z.object({ available: z.literal(false), reason: z.literal("encrypted") }).strict(), secret: z.object({ configured: z.literal(true), readable: z.literal(false) }).strict(), delivery: z.union([z.object({ available: z.boolean(), state: z.enum(["ready", "pending", "delivered", "attention", "disabled"]), pending: z.number().int(), processing: z.number().int(), delivered: z.number().int(), dead: z.number().int(), lastErrorCode: z.string().nullable() }).strict(), z.object({ available: z.literal(false), reason: z.literal("delivery_worker_unavailable") }).strict()]) }).strict();
export const AuditEndpointContracts = {
  list: z.object({ data: z.array(AuditTimelineItem), nextCursor: Cursor, capabilities: z.object({ chainVerification: z.literal("available"), destinations: z.literal("available"), compaction: z.literal("not_applicable") }).strict() }).strict(),
  detail: z.object({ data: AuditEvent }).strict(),
  destinationCreate: z.object({ kind: z.enum(["webhook", "siem"]), label: z.string().trim().min(1).max(120), endpoint: z.string().url().refine((value) => value.startsWith("https://")), secret: z.string().max(4096).nullable().optional() }).strict(),
  destinationPatch: z.object({ kind: z.enum(["webhook", "siem"]).optional(), label: z.string().trim().min(1).max(120).optional(), endpoint: z.string().url().refine((value) => value.startsWith("https://")).optional(), secret: z.string().max(4096).nullable().optional() }).strict(),
  destination: z.union([z.object({ data: AuditDestination }).strict(), AuditDestination]),
  destinationCreateResponse: AuditDestination.omit({ createdAt: true, updatedAt: true }),
  destinationList: z.object({ data: z.array(AuditDestination) }).strict(),
  verify: z.object({ data: z.discriminatedUnion("verified", [z.object({ verified: z.literal(true), checked: z.number().int(), legacy: z.number().int(), latestHash: z.string().nullable() }).strict(), z.object({ verified: z.literal(false), checked: z.number().int(), legacy: z.number().int(), firstFailure: z.object({ id: Id, reason: z.enum(["sequence_gap", "predecessor_mismatch", "hash_mismatch"]) }).strict() }).strict()]), verification: z.object({ scope: z.literal("all_v1_workspace_events"), legacyRecordsExcluded: z.number().int() }).strict() }).strict(),
} as const;
export const SettingsContracts = {
  workspace: z.object({ name: NonEmptyString }).strict(),
  cliDecision: z.object({ userCode: z.string().regex(/^[A-F0-9]{5}-[A-F0-9]{5}$/) }).strict(),
  response: z.union([CursorResponse, DataResponse, IdResponse, StatusResponse]),
} as const;
const SettingsPageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict().transform(({ cursor, limit }) => ({ cursor: cursor ?? null, limit: limit ?? 50 }));
const SettingsEmptyQuery = z.object({}).strict();
const SettingTeam = z.object({ id: Id, slug: z.string(), name: z.string(), costCenterId: z.string().nullable(), createdAt: z.string() }).strict();
const SettingCostCenter = z.object({ id: Id, slug: z.string(), name: z.string(), parentId: z.string().nullable(), createdAt: z.string() }).strict();
const SettingApp = z.object({ id: Id, slug: z.string(), name: z.string(), status: z.string(), defaultCapturePolicy: JsonValue, createdAt: z.string() }).strict();
const SettingAction = z.object({ id: Id, slug: z.string(), name: z.string().nullable(), source: z.string() }).strict();
const SettingMemberRole = z.enum(["owner", "admin", "editor", "viewer", "billing"]);
const SettingMember = z.object({ id: Id, email: z.string(), name: z.string().nullable(), role: SettingMemberRole, status: z.enum(["active", "disabled"]), createdAt: z.string() }).strict();
const TokenPublic = z.object({ id: Id, displayPrefix: z.string(), scopes: z.array(z.string()), expiresAt: z.string().nullable() }).strict();
const ArchivedSetting = z.object({ data: z.object({ id: Id, archived: z.literal(true) }).strict() }).strict();
const OptionalFields = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial().strict().refine((value) => Object.keys(value).length > 0, "at least one field is required");
export const SettingsEndpointContracts = {
  emptyQuery: SettingsEmptyQuery,
  pageQuery: SettingsPageQuery,
  tokenMint: z.object({ scopes: z.array(z.string().min(1)).min(1), expiresAt: z.string().nullable().optional() }).strict(),
  // `plaintext` is present only in the creation response; no list/read schema includes it.
  tokenMintResponse: z.object({ data: TokenPublic.extend({ plaintext: z.string().min(1) }).strict() }).strict(),
  tokenList: z.object({ data: z.array(TokenPublic.extend({ createdByMemberId: z.string().nullable(), revokedAt: z.string().nullable(), lastUsedAt: z.string().nullable(), createdAt: z.string() }).strict()), nextCursor: Cursor }).strict(),
  tokenRevoke: z.object({ data: z.object({ id: Id, revoked: z.literal(true) }).strict() }).strict(),
  team: z.object({ slug: z.string().min(1), name: z.string().min(1), costCenterId: z.string().nullable().optional() }).strict(),
  teamUpdate: OptionalFields({ slug: z.string().min(1), name: z.string().min(1), costCenterId: z.string().nullable() }),
  teamResponse: z.object({ data: SettingTeam }).strict(),
  teamArchived: ArchivedSetting,
  costCenter: z.object({ slug: z.string().min(1), name: z.string().min(1), parentId: z.string().nullable().optional() }).strict(),
  costCenterUpdate: OptionalFields({ slug: z.string().min(1), name: z.string().min(1), parentId: z.string().nullable() }),
  costCenterResponse: z.object({ data: SettingCostCenter }).strict(),
  costCenterArchived: ArchivedSetting,
  app: z.object({ slug: z.string().min(1), name: z.string().min(1), defaultCapturePolicy: z.record(JsonValue).optional() }).strict(),
  appUpdate: OptionalFields({ slug: z.string().min(1), name: z.string().min(1), defaultCapturePolicy: z.record(JsonValue) }),
  appResponse: z.object({ data: SettingApp }).strict(),
  appCreateResponse: z.object({ data: SettingApp.extend({ actions: z.array(SettingAction.extend({ createdAt: z.string() }).strict()) }).strict() }).strict(),
  appArchived: ArchivedSetting,
  action: z.object({ slug: z.string().min(1), name: z.string().nullable().optional() }).strict(),
  actionUpdate: OptionalFields({ slug: z.string().min(1), name: z.string().nullable() }),
  actionResponse: z.object({ data: SettingAction }).strict(),
  actionArchived: ArchivedSetting,
  member: z.object({ email: z.string().email(), name: z.string().nullable().optional(), role: SettingMemberRole }).strict(),
  memberUpdate: OptionalFields({ role: SettingMemberRole, disabled: z.boolean() }),
  memberResponse: z.object({ data: SettingMember }).strict(),
  workspace: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
  workspaceResponse: z.object({ data: z.object({ id: Id, slug: z.string(), name: z.string(), region: z.string(), storagePolicy: z.object({ ceilingBytes: z.string(), warnPct: z.number(), highPct: z.number(), critPct: z.number() }).strict(), createdAt: z.string(), updatedAt: z.string() }).strict() }).strict(),
  cliDecision: z.object({ userCode: z.string().regex(/^[A-F0-9]{5}-[A-F0-9]{5}$/) }).strict(),
  cliApproved: z.object({ data: z.object({ id: Id, status: z.literal("approved"), scopes: z.array(z.string()) }).strict() }).strict(),
  cliDenied: z.object({ data: z.object({ id: Id, status: z.literal("denied") }).strict() }).strict(),
  alerts: z.object({ data: z.array(z.object({ id: Id, scopeType: z.string(), scopeId: z.string().nullable(), metric: z.string(), threshold: z.string(), window: z.string(), destinations: JsonValue, status: z.enum(["active", "disabled"]), createdAt: z.string() }).strict()), nextCursor: Cursor }).strict(),
  cliList: z.object({ data: z.array(z.object({ id: Id, userCode: z.string(), status: z.string(), requestedScopes: z.array(z.string()), client: z.object({ id: z.string(), name: z.string() }).strict(), verificationOrigin: z.string(), intervalSeconds: z.number().int(), expiresAt: z.string(), createdAt: z.string(), approvedAt: z.string().nullable(), deniedAt: z.string().nullable(), canReview: z.boolean() }).strict()), nextCursor: Cursor }).strict(),
  settingsIndex: z.object({ data: z.object({ workspace: z.string(), members: z.string(), teams: z.string(), costCenters: z.string(), tokens: z.string(), apps: z.string(), alerts: z.string(), cliAuthorization: z.string(), dangerZone: z.string() }).strict() }).strict(),
  dangerZone: z.object({ data: z.object({ workspaceDeletion: z.object({ available: z.literal(false), reasonCode: z.literal("WORKSPACE_DELETION_UNSUPPORTED"), message: z.string() }).strict(), dependencies: z.object({ members: z.number().int(), teams: z.number().int(), costCenters: z.number().int(), apps: z.number().int(), activeTokens: z.number().int(), observations: z.number().int() }).strict() }).strict() }).strict(),
  lists: { team: Page(SettingTeam), costCenter: Page(SettingCostCenter), app: Page(SettingApp.extend({ actions: z.array(SettingAction.extend({ createdAt: z.string() }).strict()) }).strict()), member: Page(SettingMember) },
} as const;
export const InternalContracts = {
  emptyQuery: EmptyRequest,
  auditDelivery: z.object({ workspaceId: NonEmptyString, limit: z.number().int().min(1).max(50) }).strict(),
  storageCompactionQuery: z.object({ jobId: NonEmptyString, workspaceId: NonEmptyString }).strict(),
  auditDeliveryResponse: z.object({ claimed: z.number().int().nonnegative(), delivered: z.number().int().nonnegative(), retried: z.number().int().nonnegative(), dead: z.number().int().nonnegative() }).strict(),
  auditDeliveryCronResponse: z.object({ workspaces: z.number().int().nonnegative(), claimed: z.number().int().nonnegative(), delivered: z.number().int().nonnegative(), retried: z.number().int().nonnegative(), dead: z.number().int().nonnegative() }).strict(),
  keyGraceExpiryResponse: z.object({ workspaces: z.number().int().nonnegative(), expired: z.number().int().nonnegative(), published: z.number().int().nonnegative(), reconciled: z.number().int().nonnegative(), retried: z.number().int().nonnegative() }).strict(),
  configPublicationRecoveryResponse: z.object({
    config: z.object({ attempted: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }).strict(),
    keys: z.object({ attempted: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }).strict(),
  }).strict(),
  targetHealthCronResponse: z.object({
    workspaces: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    rolledUp: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    noop: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
  }).strict(),
  mutationCleanupResponse: z.object({
    replayRowsDeleted: z.number().int().nonnegative(),
    rateBucketsDeleted: z.number().int().nonnegative(),
  }).strict(),
  storageMeasureCronResponse: z.object({
    workspaces: z.number().int().nonnegative(), measured: z.number().int().nonnegative(),
    compactionsQueued: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  }).strict(),
  storageCompactionScheduleResponse: z.object({
    cadence: z.enum(["hourly", "daily", "monthly"]), workspaces: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
  }).strict(),
  storageCompactionDrainResponse: z.object({
    discovered: z.number().int().nonnegative(), done: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(), contention: z.number().int().nonnegative(),
    incomplete: z.number().int().nonnegative(),
    notFound: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  }).strict(),
  storageCompactionResponse: z.union([
    z.object({ status: z.literal("contention"), code: z.literal("COMPACTION_IN_PROGRESS") }).strict(),
    z.object({ status: z.literal("not_found") }).strict(),
    z.object({ status: z.literal("blocked"), blocker: z.object({
      code: z.enum(["RETENTION_PREREQUISITES_MISSING", "EXPORT_VERIFICATION_FAILED"]),
      missing: z.array(z.string()), destructiveWorkSkipped: z.literal(true).optional(),
    }).strict(), beforeBytes: z.number(), afterBytes: z.number(), freedBytes: z.number() }).strict(),
    z.object({ status: z.literal("incomplete"), beforeBytes: z.number() }).strict(),
    z.object({ status: z.literal("done"), beforeBytes: z.number(), afterBytes: z.number(), freedBytes: z.number() }).strict(),
  ]),
  response: InternalResponse,
} as const;
export const AdminContracts = {
  seed: z.object({ slug: z.string().min(1).optional(), name: z.string().min(1).optional(), email: z.string().email().optional(), region: z.string().min(1).optional() }).strict(),
  seedResponse: z.object({ workspaceId: z.string(), slug: z.string(), hostname: z.string(), apiToken: z.string(), memberId: z.string(), tokenId: z.string(), installationId: z.string(), profileId: z.string(), appId: z.string(), offeringId: z.string() }).strict(),
  response: z.union([DataResponse, StatusResponse, InternalResponse]),
} as const;

/** Active snapshots are signed over their serialized JSON bytes.  Routes must validate the
 * exact byte string they emit, never a reparsed/re-serialized approximation. */
export const ActiveSnapshotWireBytes = z.string().min(2).refine((wire) => {
  try { return JSON.stringify(JSON.parse(wire)) === wire; } catch { return false; }
}, "active snapshot must be canonical JSON bytes");

/** One strict registry key per public /api/v1 family, including internal/admin routes. */
export const ControlPlaneEndpointContracts = {
  registry: RegistryContracts, providers: ProviderContracts, routes: RouteContracts, profiles: ProfileContracts,
  policies: PolicyContracts, config: ConfigContracts, installations: InstallationContracts,
  deployments: DeploymentContracts, keys: KeyContracts, budgets: BudgetContracts,
  observations: ObservationContracts, usage: UsageContracts, storage: StorageContracts,
  audit: AuditContracts, settings: SettingsContracts, internal: InternalContracts, admin: AdminContracts,
} as const;

/** Backwards-compatible concise registry name for route-level contract adoption. */
export const ControlPlaneContracts = ControlPlaneEndpointContracts;

// Resource-family contracts.  Unlike the transitional family registries above,
// these name each public operation and pin its complete wire projection.
// JSON-valued policy/capability columns are deliberately represented as JSON;
// their enclosing resource objects remain strict.
const StrictRateLimit = z.object({
  rpm: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
  burst: z.number().int().positive().optional(),
}).strict().nullable();
const StrictTarget = z.object({
  providerCredentialId: NonEmptyString,
  offeringId: NonEmptyString,
  baseUrl: z.string().url().nullable().optional(),
  deployment: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  weight: z.number().int().nonnegative().optional(),
  priority: z.number().int().nonnegative().optional(),
}).strict();
const StrictRevision = z.object({
  mode: z.string().optional(),
  targets: z.array(StrictTarget).min(1),
  retryPolicy: z.object({ maxAttempts: z.number().int().positive().optional(), retryOn: z.array(z.string()).optional(), backoffMs: z.number().int().nonnegative().optional() }).strict().optional(),
  timeoutPolicy: z.object({ connectMs: z.number().int().nonnegative().optional(), firstByteMs: z.number().int().nonnegative().optional(), overallMs: z.number().int().nonnegative().optional() }).strict().optional(),
  capturePolicy: z.record(JsonValue).optional(),
}).strict();
const KeyAttribution = z.object({ teamId: NullableString, costCenterId: NullableString, budgetAccountId: NullableString }).strict();
const KeyView = z.object({
  id: z.string(), displayPrefix: z.string(), profileId: z.string(), profileMode: z.string(),
  scopes: z.array(z.string()), allowedAppIds: z.array(z.string()), defaultAppId: NullableString,
  defaultActionId: NullableString, attribution: KeyAttribution, rateLimit: StrictRateLimit,
  expiresAt: NullableString, lastUsedAt: NullableString, createdAt: z.string(), revoked: z.boolean(),
  expired: z.boolean(), successorKeyId: NullableString, successorActive: z.boolean(),
  graceExpiresAt: NullableString, rotating: z.boolean(),
}).strict();
const Price = z.object({
  id: z.string(), fidelity: NullableString, source: z.string().optional(), effectiveFrom: NullableString,
  currency: z.literal("USD"), unit: z.literal("per_mtok"), inputPerMtokMicrousd: NullableString,
  outputPerMtokMicrousd: NullableString, cacheReadPerMtokMicrousd: NullableString.optional(),
  cacheWritePerMtokMicrousd: NullableString.optional(), reasoningPerMtokMicrousd: NullableString.optional(),
  audioInPerMtokMicrousd: NullableString.optional(), audioOutPerMtokMicrousd: NullableString.optional(),
}).strict();

export const ProvidersApi = {
  createRequest: z.object({ provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i), label: NonEmptyString, secret: NonEmptyString, baseUrl: z.string().url().nullable().optional(), allowedHosts: z.array(NonEmptyString).optional() }).strict(),
  rotateRequest: z.object({ secret: NonEmptyString }).strict(),
  emptyRequest: EmptyRequest,
  listResponse: Page(z.object({ id: z.string(), provider: z.string(), label: z.string(), baseUrl: NullableString, status: z.string(), lastValidatedAt: NullableString, createdAt: z.string() }).strict()),
  createResponse: z.object({ id: z.string(), provider: z.string(), label: z.string(), status: z.literal("unvalidated") }).strict(),
  rotateResponse: z.object({ id: z.string(), status: z.literal("unvalidated"), rotated: z.literal(true), plaintextStored: z.literal(false) }).strict(),
  revokeResponse: z.object({ id: z.string(), revoked: z.literal(true) }).strict(),
  validateResponse: z.object({ id: z.string(), status: z.enum(["valid", "invalid"]), validated: z.boolean(), outcome: z.string(), classification: z.string(), upstreamStatus: z.number().int().nullable(), message: z.string(), responseTruncated: z.boolean() }).strict(),
  detailResponse: z.object({
    id: z.string(), provider: z.string(), label: z.string(), baseUrl: NullableString, deployment: JsonValue,
    allowedHosts: z.array(z.string()), status: z.string(), lastValidatedAt: NullableString, revokedAt: NullableString,
    createdAt: z.string(), updatedAt: z.string(), offerings: z.array(z.object({ id: z.string(), canonicalModel: z.object({ id: z.string(), slug: z.string(), displayName: z.string() }).strict(), providerModelId: z.string(), endpointKinds: z.array(z.string()), capabilities: JsonValue, region: NullableString, activePrice: z.object({ id: z.string(), fidelity: NullableString, effectiveFrom: NullableString, currency: z.literal("USD"), unit: z.literal("per_mtok"), inputPerMtokMicrousd: NullableString, outputPerMtokMicrousd: NullableString }).strict().nullable() }).strict()),
  }).strict(),
} as const;

export const KeysApi = {
  mintRequest: z.object({ profileId: NonEmptyString, scopes: z.array(NonEmptyString).optional(), allowedAppIds: z.array(NonEmptyString).optional(), defaultAppId: OptionalNullableString, defaultActionId: OptionalNullableString, teamId: OptionalNullableString, costCenterId: OptionalNullableString, budgetAccountId: OptionalNullableString, rateLimit: StrictRateLimit.optional(), expiresAt: OptionalNullableString }).strict(),
  patchRequest: z.object({ scopes: z.array(NonEmptyString).optional(), allowedAppIds: z.array(NonEmptyString).optional(), defaultAppId: OptionalNullableString, defaultActionId: OptionalNullableString, teamId: OptionalNullableString, costCenterId: OptionalNullableString, budgetAccountId: OptionalNullableString, rateLimit: StrictRateLimit.optional(), expiresAt: OptionalNullableString }).strict().refine((body) => Object.keys(body).length > 0, "at least one field is required"),
  rotateRequest: z.object({ graceSeconds: z.number().int().min(60).max(86_400).optional() }).strict(),
  emptyRequest: EmptyRequest,
  listResponse: Page(KeyView), detailResponse: KeyView,
  mintResponse: z.object({ keyId: z.string(), displayPrefix: z.string(), plaintext: z.string(), published: z.boolean() }).strict(),
  patchResponse: KeyView.extend({ published: z.boolean() }).strict(),
  rotateResponse: z.object({ predecessorKeyId: z.string(), successorKeyId: z.string(), displayPrefix: z.string(), plaintext: z.string(), graceExpiresAt: z.string(), graceSemantics: z.string(), published: z.boolean() }).strict(),
  revokeResponse: z.object({ id: z.string(), revoked: z.literal(true), published: z.boolean() }).strict(),
} as const;

export const RoutesApi = {
  createRequest: z.object({ installationId: NonEmptyString, publicName: NonEmptyString, endpointKind: z.enum(["chat", "responses", "embeddings"]).optional(), target: StrictTarget.optional(), targets: z.array(StrictTarget).min(1).optional(), mode: z.string().optional(), retryPolicy: StrictRevision.shape.retryPolicy, timeoutPolicy: StrictRevision.shape.timeoutPolicy, capturePolicy: StrictRevision.shape.capturePolicy }).strict().refine((body) => !(body.target && body.targets), "target and targets are mutually exclusive"),
  revisionRequest: StrictRevision,
  testRequest: z.object({ profileId: NonEmptyString.optional() }).strict(),
  emptyRequest: EmptyRequest,
  listResponse: Page(z.object({ id: z.string(), publicName: z.string(), endpointKind: z.string(), installationId: z.string(), activeRevisionId: NullableString, status: z.enum(["staged", "draft"]), targetCount: z.number().int().nonnegative(), healthyTargetCount: z.number().int().nonnegative(), createdAt: z.string() }).strict()),
  detailResponse: z.object({ id: z.string(), installationId: z.string(), installationName: z.string(), publicName: z.string(), endpointKind: z.string(), activeRevisionId: NullableString, status: z.enum(["disabled", "staged", "draft"]), disabledAt: NullableString, createdAt: z.string(), updatedAt: z.string(), revisions: z.array(z.object({ id: z.string(), mode: z.string(), retryPolicy: z.record(JsonValue), timeoutPolicy: z.record(JsonValue), capturePolicy: z.record(JsonValue), contentHash: z.string(), createdBy: NullableString, createdAt: z.string(), isActive: z.boolean(), targets: z.array(z.object({ id: z.string(), providerCredentialId: z.string(), offeringId: z.string(), provider: z.string(), credentialLabel: z.string(), credentialStatus: z.string(), providerModelId: z.string(), adapterRevision: z.string(), baseUrl: NullableString, deployment: NullableString, region: NullableString, weight: z.number().int(), priority: z.number().int(), healthState: z.string(), createdAt: z.string() }).strict()) }).strict()) }).strict(),
  createResponse: z.object({ id: z.string(), status: z.literal("staged"), revisionId: z.string(), unpublishedChanges: z.number().int() }).strict(),
  revisionResponse: z.object({ routeId: z.string(), revisionId: z.string(), contentHash: z.string(), status: z.literal("staged"), publishRequired: z.literal(true) }).strict(),
  disableResponse: z.object({ id: z.string(), status: z.literal("disabled"), changed: z.boolean(), publishRequired: z.literal(true) }).strict(),
  testResponse: z.object({ routeId: z.string(), installationId: z.string(), profile: z.object({ id: z.string(), hostname: z.string(), mode: z.string() }).strict(), status: z.enum(["completed", "gateway_error"]), gatewayStatus: z.number().int(), traceId: NullableString, logsHref: NullableString, responseTruncated: z.boolean() }).strict(),
} as const;

const CanonicalModel = z.object({ id: z.string(), slug: z.string(), displayName: z.string(), family: NullableString, modalityIn: JsonValue, modalityOut: JsonValue, openWeights: z.boolean().nullable(), source: z.string() }).strict();
const ModelOffering = z.object({ id: z.string(), canonicalModel: CanonicalModel, provider: z.string(), providerModelId: z.string(), endpointKinds: z.array(z.string()), adapterRevision: z.string(), capabilities: JsonValue, limits: z.object({ contextTokens: NullableString, outputTokens: NullableString }).strict(), region: NullableString, routable: z.boolean(), activePrice: Price.nullable() }).strict();
export const ModelsApi = {
  listQuery: z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    provider: z.string().min(1).max(120).optional(),
    endpointKind: z.enum(["chat", "responses", "embeddings"]).optional(),
    q: z.string().min(1).max(256).optional(),
    routable: z.enum(["true", "false"]).optional(),
    family: z.string().min(1).max(120).optional(),
    priceFidelity: z.enum(["provider_verified", "operator_override", "aggregator", "unknown"]).optional(),
  }).strict().transform(({ cursor, limit, provider, endpointKind, q, routable, family, priceFidelity }) => ({ cursor: cursor ?? null, limit: limit ?? 50, provider: provider ?? null, endpointKind: endpointKind ?? null, query: q ?? null, routable: routable ?? null, family: family ?? null, priceFidelity: priceFidelity ?? null })),
  overrideRequest: z.object({ offeringId: NonEmptyString, inputPerMtokMicrousd: OptionalNullableString, outputPerMtokMicrousd: OptionalNullableString, cacheReadPerMtokMicrousd: OptionalNullableString, cacheWritePerMtokMicrousd: OptionalNullableString, reasoningPerMtokMicrousd: OptionalNullableString, audioInPerMtokMicrousd: OptionalNullableString, audioOutPerMtokMicrousd: OptionalNullableString }).strict(),
  listResponse: Page(ModelOffering), detailResponse: ModelOffering,
  overrideResponse: z.object({ id: z.string(), offeringId: z.string(), fidelity: z.literal("operator_override"), contentHash: z.string(), status: z.literal("staged"), publishRequired: z.literal(true), replay: z.boolean() }).strict(),
  previewResponse: z.object({ profile: z.object({ id: z.string(), hostname: z.string(), available: z.boolean() }).strict(), data: z.array(z.object({ id: z.string(), model: z.string(), endpointKind: z.string(), canonicalModel: z.object({ id: z.string(), slug: z.string() }).strict(), provider: z.string(), providerModelId: z.string() }).strict()), publishRequired: z.literal(true), note: z.string() }).strict(),
} as const;
