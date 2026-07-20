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
  "VALIDATION",
  "NOT_FOUND",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** OpenAI-shaped data-plane error envelope (SPEC §0.3). */
export const GatewayError = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable().optional(),
    code: z.string(),
  }),
});
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
  }),
});
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
});
export type HealthResponse = z.infer<typeof HealthResponse>;
