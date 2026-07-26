// Bounded, OpenAI-compatible request decoding. This module deliberately has no provider-specific
// translation: OpenAI Chat and Responses remain distinct wire protocols all the way to dispatch.
import type { EndpointKind } from "@manifold/ports";

export type OpenAiEndpointKind = EndpointKind | "models";

export interface DecodedOpenAiRequest {
  endpointKind: OpenAiEndpointKind;
  /** The public model name supplied by the caller. `undefined` is valid only for GET /v1/models. */
  publicModel: string | undefined;
  /** Parsed POST JSON, retained without schema narrowing so unknown OpenAI fields survive routing. */
  body: Record<string, unknown> | undefined;
  /** A fresh, unread request with the original URL, query, headers, method, and body bytes. */
  request: Request;
}

export interface DecodeOpenAiRequestOptions {
  /** Maximum accepted POST body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

/** Safe, client-facing failures raised before authentication/routing/dispatch. */
export class RequestCodecError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestCodecError";
    this.status = status;
    this.code = code;
  }
}

/** The provider-model field emitted in a signed snapshot offering. */
export interface OfferingWithProviderModelId {
  providerModelId: string;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function codecError(status: number, code: string, message: string): never {
  throw new RequestCodecError(status, code, message);
}

function endpointFor(url: URL): OpenAiEndpointKind | undefined {
  switch (url.pathname) {
    case "/v1/chat/completions": return "chat";
    case "/v1/responses": return "responses";
    case "/v1/embeddings": return "embeddings";
    case "/v1/models": return "models";
    default: return undefined;
  }
}

function validBodyCap(value: number | undefined): number {
  const cap = value ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new TypeError("maxBodyBytes must be a non-negative safe integer");
  }
  return cap;
}

function isJsonContentType(value: string | null): boolean {
  // A few OpenAI-compatible clients omit Content-Type while still sending JSON. Accept absence
  // for compatibility; reject an explicit non-JSON declaration.
  return value === null || value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function contentLengthExceeds(request: Request, cap: number): boolean {
  const value = request.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value.trim())) return false;
  const length = Number(value);
  return Number.isSafeInteger(length) && length > cap;
}

async function readBodyWithin(request: Request, cap: number): Promise<Uint8Array> {
  if (contentLengthExceeds(request, cap)) {
    return codecError(413, "POLICY_BODY_TOO_LARGE", "request body exceeds the allowed size");
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > cap) {
        await reader.cancel();
        return codecError(413, "POLICY_BODY_TOO_LARGE", "request body exceeds the allowed size");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function replayRequest(request: Request, body: Uint8Array): Request {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return new Request(request.url, { method: request.method, headers: new Headers(request.headers) });
  }
  return new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers),
    // TS's DOM lib currently models its generic Uint8Array more narrowly than the Fetch body
    // runtime does; Uint8Array is a standard BodyInit and is preserved byte-for-byte here.
    body: body as unknown as BodyInit,
  });
}

/**
 * Decode the supported OpenAI-compatible surface. POSTs are copied into a replayable Request
 * after a capped streaming read; the original request is intentionally consumed exactly once.
 */
export async function decodeOpenAiRequest(
  request: Request,
  options: DecodeOpenAiRequestOptions = {},
): Promise<DecodedOpenAiRequest> {
  const endpointKind = endpointFor(new URL(request.url));
  if (!endpointKind) {
    return codecError(404, "ROUTE_ENDPOINT_UNSUPPORTED", "unsupported endpoint");
  }

  const expectedMethod = endpointKind === "models" ? "GET" : "POST";
  if (request.method.toUpperCase() !== expectedMethod) {
    return codecError(405, "REQUEST_METHOD_UNSUPPORTED", "unsupported method for endpoint");
  }

  if (endpointKind === "models") {
    return { endpointKind, publicModel: undefined, body: undefined, request: replayRequest(request, new Uint8Array()) };
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return codecError(415, "REQUEST_CONTENT_TYPE_UNSUPPORTED", "content-type must be application/json");
  }

  const bytes = await readBodyWithin(request, validBodyCap(options.maxBodyBytes));
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return codecError(400, "REQUEST_JSON_MALFORMED", "request body must be valid JSON");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return codecError(400, "REQUEST_JSON_MALFORMED", "request body must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;
  if (typeof body.model !== "string") {
    return codecError(400, "REQUEST_MODEL_REQUIRED", "request body must include a string model");
  }
  return { endpointKind, publicModel: body.model, body, request: replayRequest(request, bytes) };
}

/**
 * Rebuild an OpenAI-compatible provider request after target selection. Only `model` is changed;
 * endpoint path (including Responses), query pairs, headers, and all other JSON members are kept.
 */
export function toOpenAiProviderRequest(
  decoded: DecodedOpenAiRequest,
  offering: OfferingWithProviderModelId,
  bodyOverride?: Record<string, unknown>,
): Request {
  if (decoded.endpointKind === "models" || !decoded.body) return decoded.request;
  const headers = new Headers(decoded.request.headers);
  headers.delete("content-length");
  const body = JSON.stringify({ ...(bodyOverride ?? decoded.body), model: offering.providerModelId });
  return new Request(decoded.request.url, { method: decoded.request.method, headers, body });
}

// Short aliases keep the integration seam unsurprising for adapters while retaining explicit names.
export const decodeRequest = decodeOpenAiRequest;
export const transformOpenAiProviderRequest = toOpenAiProviderRequest;
