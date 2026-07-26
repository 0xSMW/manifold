import { SCHEMA_VERSION } from "@manifold/contracts";

export interface ApiErrorPayload {
  code: string;
  message: string;
  reason_codes: string[];
  remediation?: string;
  request_id: string;
  schema: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ControlPlaneApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = "ControlPlaneApiError";
    this.status = status;
    this.payload = payload;
  }
}

interface ApiRequestInit extends Omit<RequestInit, "body"> {
  body?: unknown;
}

function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function cookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const entry = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
}

export async function apiRequest<T>(
  path: string,
  init: ApiRequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Manifold-Schema", SCHEMA_VERSION);

  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.body);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("Idempotency-Key")) {
    headers.set("Idempotency-Key", idempotencyKey());
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("X-Manifold-CSRF")) {
    const csrf = cookieValue("manifold_csrf");
    if (csrf) headers.set("X-Manifold-CSRF", csrf);
  }

  const response = await fetch(path.startsWith("/api/") ? path : `/api/v1${path}`, {
    ...init,
    method,
    body,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: ApiErrorPayload }
    | null;
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload && payload.error
        ? payload.error
        : {
            code: "INTERNAL",
            message: `request failed with status ${response.status}`,
            reason_codes: [],
            request_id: response.headers.get("X-Request-Id") ?? "unknown",
            schema: response.headers.get("X-Manifold-Schema") ?? SCHEMA_VERSION,
            retryable: response.status >= 500,
          };
    throw new ControlPlaneApiError(response.status, error);
  }
  return payload as T;
}

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}
