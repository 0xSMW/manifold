// OpenAI-shaped data-plane error envelopes (SPEC §0.3). Guard failures return these so a
// base-URL swap is transparent to OpenAI-compatible clients. Every response also carries
// X-Trace-Id before the body (§0.3).
import type { ReasonCode } from "@manifold/contracts";

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    /** The Manifold reason code (§0.2) or a synthetic guard code. */
    code: string;
  };
}

export interface ErrorShape {
  status: number;
  type: string;
  param: string | null;
}

/** Map a reason code (or synthetic guard code) to an HTTP status + OpenAI type/param. */
export function shapeForCode(code: string): ErrorShape {
  switch (code) {
    case "AUTH_KEY_UNKNOWN":
    case "AUTH_KEY_REVOKED":
    case "AUTH_KEY_EXPIRED":
    case "AUTH_PROFILE_MISMATCH":
      return { status: 401, type: "authentication_error", param: null };
    case "ROUTE_UNKNOWN":
      return { status: 404, type: "invalid_request_error", param: "model" };
    case "ROUTE_ENDPOINT_UNSUPPORTED":
      return { status: 404, type: "invalid_request_error", param: null };
    case "ROUTE_NO_HEALTHY_TARGET":
      return { status: 503, type: "api_error", param: null };
    case "PROVIDER_TIMEOUT":
      return { status: 504, type: "api_error", param: null };
    case "PROVIDER_HTTP_5XX":
      return { status: 502, type: "api_error", param: null };
    // Synthetic guard codes (no reason-code registry entry): pre-auth profile + egress safety.
    case "PROFILE_UNKNOWN":
      return { status: 404, type: "invalid_request_error", param: null };
    case "SSRF_BLOCKED":
      return { status: 403, type: "invalid_request_error", param: null };
    default:
      return { status: 400, type: "invalid_request_error", param: null };
  }
}

/** Build an OpenAI-shaped error Response with X-Trace-Id, given a code and message. */
export function errorResponse(code: string, message: string, traceId: string): Response {
  const shape = shapeForCode(code);
  const body: OpenAiErrorBody = {
    error: { message, type: shape.type, param: shape.param, code },
  };
  return new Response(JSON.stringify(body), {
    status: shape.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-trace-id": traceId,
    },
  });
}

/** Reason codes are a subset of guard codes; this narrows for call sites that have one. */
export function reasonResponse(reason: ReasonCode, message: string, traceId: string): Response {
  return errorResponse(reason, message, traceId);
}
