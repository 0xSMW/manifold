import type { SyntheticEndpointKind, SyntheticGatewayResult } from "@/lib/synthetic-test";

export const SYNTHETIC_FAILURE_CODES = [
  "SYNTHETIC_NOT_CONFIGURED",
  "SYNTHETIC_POLICY",
  "SYNTHETIC_DNS",
  "SYNTHETIC_TIMEOUT",
  "SYNTHETIC_NETWORK",
  "SYNTHETIC_EXECUTION_FAILED",
] as const;

export type SyntheticFailureCode = typeof SYNTHETIC_FAILURE_CODES[number];

export interface SyntheticAuditIdentity {
  installationId: string;
  profileId: string;
  endpointKind: SyntheticEndpointKind;
  configRevisionId: string | null;
  appliedConfigRevisionId: string | null;
}

export type SyntheticAuditDetail = (
  | (SyntheticAuditIdentity & {
      kind: "gateway_response";
      gatewayStatus: number;
      traceId: string | null;
      responseTruncated: boolean;
    })
  | (SyntheticAuditIdentity & {
      kind: "execution_failure";
      failureCode: SyntheticFailureCode;
      retryable: boolean;
    })
) & Record<string, unknown>;

export function gatewayResponseAuditDetail(
  identity: SyntheticAuditIdentity,
  result: SyntheticGatewayResult,
): SyntheticAuditDetail {
  return { ...identity, kind: "gateway_response", ...result };
}

export function executionFailureAuditDetail(
  identity: SyntheticAuditIdentity,
  failureCode: SyntheticFailureCode,
): SyntheticAuditDetail {
  return {
    ...identity,
    kind: "execution_failure",
    failureCode,
    retryable: failureCode === "SYNTHETIC_TIMEOUT" || failureCode === "SYNTHETIC_NETWORK" || failureCode === "SYNTHETIC_EXECUTION_FAILED",
  };
}

function isFailureCode(value: unknown): value is SyntheticFailureCode {
  return typeof value === "string" && (SYNTHETIC_FAILURE_CODES as readonly string[]).includes(value);
}

/** Normalizes current and legacy audit JSON without surfacing raw request or response data. */
export function parseSyntheticAuditDetail(value: unknown): SyntheticAuditDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  if (
    typeof detail.installationId !== "string" ||
    typeof detail.profileId !== "string" ||
    (detail.endpointKind !== "chat" && detail.endpointKind !== "responses" && detail.endpointKind !== "embeddings")
  ) return null;
  const identity: SyntheticAuditIdentity = {
    installationId: detail.installationId,
    profileId: detail.profileId,
    endpointKind: detail.endpointKind,
    configRevisionId: typeof detail.configRevisionId === "string" ? detail.configRevisionId : null,
    appliedConfigRevisionId: typeof detail.appliedConfigRevisionId === "string" ? detail.appliedConfigRevisionId : null,
  };
  if (
    (detail.kind === "gateway_response" || detail.kind === undefined) &&
    typeof detail.gatewayStatus === "number" && Number.isInteger(detail.gatewayStatus) &&
    (typeof detail.traceId === "string" || detail.traceId === null) &&
    typeof detail.responseTruncated === "boolean"
  ) return gatewayResponseAuditDetail(identity, {
    gatewayStatus: detail.gatewayStatus,
    traceId: detail.traceId,
    responseTruncated: detail.responseTruncated,
  });
  if (
    detail.kind === "execution_failure" &&
    isFailureCode(detail.failureCode) &&
    typeof detail.retryable === "boolean"
  ) return { ...identity, kind: "execution_failure", failureCode: detail.failureCode, retryable: detail.retryable };
  return null;
}
