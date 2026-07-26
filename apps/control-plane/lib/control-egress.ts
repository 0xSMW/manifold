import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateIp, ssrfCheck } from "@manifold/gateway-core";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_REDIRECTS = 2;

const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-amz-security-token",
  "cookie",
  "cookie2",
]);

export type ControlEgressErrorCode =
  | "EGRESS_POLICY"
  | "EGRESS_DNS"
  | "EGRESS_TIMEOUT"
  | "EGRESS_NETWORK"
  | "EGRESS_REDIRECT";

export class ControlEgressError extends Error {
  readonly code: ControlEgressErrorCode;

  constructor(code: ControlEgressErrorCode, message: string) {
    super(message);
    this.name = "ControlEgressError";
    this.code = code;
  }
}

export interface ControlEgressRequest {
  url: string;
  allowedHosts: readonly string[];
  method?: "GET" | "HEAD" | "POST";
  headers?: HeadersInit;
  /** Bounded callers only. This transport never follows a redirect with a body. */
  body?: BodyInit | null;
}

export interface ControlEgressResponse {
  status: number;
  headers: Headers;
  url: string;
  body: Uint8Array;
  truncated: boolean;
  redirects: number;
}

export interface ControlEgressDependencies {
  resolve?: (hostname: string) => Promise<readonly string[]>;
  fetch?: (request: Request, destination: ValidatedDestination) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

export interface ValidatedDestination {
  hostname: string;
  address: string;
  family: 4 | 6;
}

async function resolveAll(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return resolved;
}

async function validateDestination(
  url: URL,
  allowedHosts: readonly string[],
  resolve: (hostname: string) => Promise<readonly string[]>,
  signal: AbortSignal,
): Promise<ValidatedDestination> {
  if (url.username || url.password) {
    throw new ControlEgressError("EGRESS_POLICY", "provider URL must not contain userinfo");
  }
  const policy = ssrfCheck(url.toString(), allowedHosts);
  if (!policy.ok) {
    throw new ControlEgressError("EGRESS_POLICY", policy.reason);
  }

  let addresses: readonly string[];
  try {
    addresses = await new Promise<readonly string[]>((resolveResult, reject) => {
      const onAbort = () =>
        reject(new ControlEgressError("EGRESS_TIMEOUT", "provider request timed out"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      resolve(url.hostname).then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolveResult(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  } catch {
    if (signal.aborted) {
      throw new ControlEgressError("EGRESS_TIMEOUT", "provider request timed out");
    }
    throw new ControlEgressError("EGRESS_DNS", "provider hostname could not be resolved");
  }
  if (addresses.length === 0) {
    throw new ControlEgressError("EGRESS_DNS", "provider hostname resolved to no addresses");
  }
  for (const address of addresses) {
    if (isIP(address) === 0 || isPrivateIp(address)) {
      throw new ControlEgressError(
        "EGRESS_POLICY",
        "provider hostname resolved to a blocked network address",
      );
    }
  }
  const address = addresses[0]!;
  return {
    hostname: url.hostname,
    address,
    family: isIP(address) as 4 | 6,
  };
}

/**
 * Options shared by the real HTTPS transport. The custom lookup callback is the DNS pin: TLS still
 * verifies/SNIs the original hostname and Node emits the original Host header, while the socket is
 * connected only to the address already checked above.
 */
export function buildPinnedHttpsRequestOptions(
  request: Request,
  destination: ValidatedDestination,
): RequestOptions {
  const url = new URL(request.url);
  return {
    protocol: "https:",
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    servername: url.hostname,
    rejectUnauthorized: true,
    family: destination.family,
    signal: request.signal,
    lookup: (_hostname, _options, callback) => {
      callback(null, destination.address, destination.family);
    },
  };
}

async function pinnedHttpsFetch(
  request: Request,
  destination: ValidatedDestination,
): Promise<Response> {
  const requestBody = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpsRequest(
      buildPinnedHttpsRequestOptions(request, destination),
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name && value !== undefined) headers.append(name, value);
        }
        const bodyForbidden = status === 204 || status === 205 || status === 304;
        if (bodyForbidden) incoming.resume();
        const body = bodyForbidden
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(requestBody);
  });
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function withoutCredentials(headers: Headers): Headers {
  const safe = new Headers(headers);
  for (const name of CREDENTIAL_HEADERS) safe.delete(name);
  return safe;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded deliberately. A cancellation failure does not relax policy.
  }
}

async function settleBeforeAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new ControlEgressError("EGRESS_TIMEOUT", "provider request timed out"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!response.body) return { body: new Uint8Array(), truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = maxBytes - total;
      if (part.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(part.value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(part.value);
      total += part.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}

/**
 * Control-plane-only provider egress. Each hop is independently allowlisted and DNS-checked.
 * Redirects are manual and same-host; provider credentials are used on the first request only.
 */
export async function executeControlEgress(
  input: ControlEgressRequest,
  dependencies: ControlEgressDependencies = {},
): Promise<ControlEgressResponse> {
  const timeoutMs = positiveInteger(
    dependencies.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxResponseBytes = positiveInteger(
    dependencies.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxRedirects = nonNegativeInteger(
    dependencies.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    "maxRedirects",
  );
  const resolve = dependencies.resolve ?? resolveAll;
  const fetcher = dependencies.fetch ?? pinnedHttpsFetch;
  const method = input.method ?? "GET";
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new ControlEgressError("EGRESS_POLICY", "provider URL is malformed");
  }
  const originalHostname = url.hostname.toLowerCase();
  let headers = new Headers(input.headers);
  let body = input.body;
  let redirects = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (true) {
      const destination = await validateDestination(
        url,
        input.allowedHosts,
        resolve,
        controller.signal,
      );

      let response: Response;
      try {
        response = await settleBeforeAbort(
          fetcher(
            new Request(url, {
              method,
              headers,
              body,
              redirect: "manual",
              signal: controller.signal,
            }),
            destination,
          ),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ControlEgressError("EGRESS_TIMEOUT", "provider request timed out");
        }
        throw new ControlEgressError("EGRESS_NETWORK", "provider request failed");
      }

      const location = response.headers.get("location");
      if (!isRedirect(response.status) || !location) {
        let bounded: { body: Uint8Array; truncated: boolean };
        try {
          bounded = await readBounded(response, maxResponseBytes);
        } catch {
          if (controller.signal.aborted) {
            throw new ControlEgressError("EGRESS_TIMEOUT", "provider request timed out");
          }
          throw new ControlEgressError("EGRESS_NETWORK", "provider response read failed");
        }
        return {
          status: response.status,
          headers: response.headers,
          url: url.toString(),
          body: bounded.body,
          truncated: bounded.truncated,
          redirects,
        };
      }

      await discardBody(response);
      if (redirects >= maxRedirects) {
        throw new ControlEgressError("EGRESS_REDIRECT", "provider redirect limit exceeded");
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new ControlEgressError("EGRESS_REDIRECT", "provider returned an invalid redirect");
      }
      if (next.hostname.toLowerCase() !== originalHostname) {
        throw new ControlEgressError(
          "EGRESS_REDIRECT",
          "provider redirected to a different host",
        );
      }
      headers = withoutCredentials(headers);
      body = null;
      url = next;
      redirects += 1;
    }
  } finally {
    clearTimeout(timer);
  }
}
