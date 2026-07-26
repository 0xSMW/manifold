export interface NormalizedProviderError {
  error: {
    message: string;
    type: "invalid_request_error" | "rate_limit_error" | "api_error";
    param: null;
    code: "provider_error";
  };
}

const DEFAULT_MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 1_024;

function errorType(status: number): NormalizedProviderError["error"]["type"] {
  if (status === 429) return "rate_limit_error";
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return "invalid_request_error";
  }
  return "api_error";
}

function fallbackMessage(status: number): string {
  if (status === 401 || status === 403) return "provider authentication failed";
  if (status === 429) return "provider rate limit exceeded";
  if (status >= 500) return "provider request failed";
  return "provider rejected the request";
}

function safeMessage(value: unknown, status: number): string {
  if (typeof value !== "string") return fallbackMessage(status);
  const sanitized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
  return sanitized || fallbackMessage(status);
}

function messageFromJson(value: unknown, status: number): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallbackMessage(status);
  }
  const record = value as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return safeMessage((nested as Record<string, unknown>).message, status);
  }
  return safeMessage(record.message, status);
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maxBytes - total) {
        await reader.cancel("provider error body exceeds observation limit").catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Convert bounded provider-specific failures into the stable OpenAI error shape.
 * Authentication details and oversized/malformed bodies fall back to generic text.
 */
export async function normalizeProviderErrorResponse(
  upstream: Response,
  traceId: string,
  maxBytes = DEFAULT_MAX_PROVIDER_ERROR_BYTES,
): Promise<Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const encoded = (upstream.headers.get("content-encoding") ?? "").trim().toLowerCase();
  let message = fallbackMessage(upstream.status);
  if (contentType.includes("application/json") && (!encoded || encoded === "identity")) {
    const bytes = await readBounded(upstream.body, maxBytes);
    if (bytes) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        // Never relay provider credential/auth detail even when it arrives in JSON.
        if (upstream.status !== 401 && upstream.status !== 403) {
          message = messageFromJson(parsed, upstream.status);
        }
      } catch {
        // Generic fallback is intentionally stable.
      }
    }
  } else {
    await upstream.body?.cancel().catch(() => undefined);
  }

  const body: NormalizedProviderError = {
    error: {
      message,
      type: errorType(upstream.status),
      param: null,
      code: "provider_error",
    },
  };
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-trace-id": traceId,
  });
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify(body), {
    status: upstream.status,
    headers,
  });
}
