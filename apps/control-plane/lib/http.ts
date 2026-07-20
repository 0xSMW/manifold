// Control-plane HTTP kit: request-id assignment, the §0.3 error envelope, and a
// `handle` wrapper that turns thrown ManifoldErrors into that envelope. Every response
// carries X-Request-Id and X-Manifold-Schema (§10.1).
import { NextResponse } from "next/server";
import { SCHEMA_VERSION } from "@manifold/contracts";

/**
 * `error.code` on the control-plane envelope. §0.2/§0.3 defines the ErrorCode enum
 * (VALIDATION, NOT_FOUND, CONFIG_PRECONDITION_FAILED, …) but has NO auth code, so we
 * additionally allow UNAUTHENTICATED/FORBIDDEN here and carry the precise AUTH_* /
 * other codes in `reason_codes[]`. Kept as a widened string for that reason.
 */
export type EnvelopeCode = string;

export interface ManifoldErrorInit {
  status: number;
  code: EnvelopeCode;
  message: string;
  reasonCodes?: string[];
  remediation?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class ManifoldError extends Error {
  status: number;
  code: EnvelopeCode;
  reasonCodes: string[];
  remediation?: string;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(init: ManifoldErrorInit) {
    super(init.message);
    this.name = "ManifoldError";
    this.status = init.status;
    this.code = init.code;
    this.reasonCodes = init.reasonCodes ?? [];
    this.remediation = init.remediation;
    this.retryable = init.retryable ?? false;
    this.details = init.details;
  }
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

function baseHeaders(requestId: string): Record<string, string> {
  return {
    "X-Request-Id": requestId,
    "X-Manifold-Schema": SCHEMA_VERSION,
    "cache-control": "no-store",
  };
}

export function ok(body: unknown, requestId: string, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: baseHeaders(requestId) });
}

export function errorEnvelope(err: ManifoldError, requestId: string): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: err.code,
        message: err.message,
        reason_codes: err.reasonCodes,
        remediation: err.remediation,
        request_id: requestId,
        schema: SCHEMA_VERSION,
        retryable: err.retryable,
        details: err.details,
      },
    },
    { status: err.status, headers: baseHeaders(requestId) },
  );
}

/**
 * Wrap a route handler: assign a request id, run it, and convert thrown errors into the
 * §0.3 envelope. Unknown errors become a 500 with a generic message (details logged).
 */
export async function handle(
  fn: (requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    return await fn(requestId);
  } catch (err) {
    if (err instanceof ManifoldError) {
      return errorEnvelope(err, requestId);
    }
    const message = err instanceof Error ? err.message : String(err);
    // Do not leak internals in the message field beyond the error string; log fully.
    console.error(`[${requestId}] unhandled error:`, err);
    return errorEnvelope(
      new ManifoldError({
        status: 500,
        code: "INTERNAL",
        message: `internal error: ${message}`,
        reasonCodes: [],
        retryable: true,
      }),
      requestId,
    );
  }
}

/** Parse + require a JSON object body, or throw 422 VALIDATION. */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "request body must be valid JSON",
      reasonCodes: [],
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "request body must be a JSON object",
      reasonCodes: [],
    });
  }
  return parsed as Record<string, unknown>;
}

/** Require a non-empty string field, else 422 VALIDATION with issue path. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: `field '${field}' is required and must be a non-empty string`,
      reasonCodes: [],
      details: { issues: [{ path: field, message: "required non-empty string" }] },
    });
  }
  return v;
}
