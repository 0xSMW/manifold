import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateIp, ssrfCheck } from "@manifold/gateway-core";

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 8_000;
const TRACE_ID_MAX_LENGTH = 256;

export type SyntheticEndpointKind = "chat" | "responses" | "embeddings";

export class SyntheticTestError extends Error {
  readonly code: "SYNTHETIC_NOT_CONFIGURED" | "SYNTHETIC_POLICY" | "SYNTHETIC_DNS" | "SYNTHETIC_TIMEOUT" | "SYNTHETIC_NETWORK";

  constructor(
    code: "SYNTHETIC_NOT_CONFIGURED" | "SYNTHETIC_POLICY" | "SYNTHETIC_DNS" | "SYNTHETIC_TIMEOUT" | "SYNTHETIC_NETWORK",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export interface SyntheticGatewayInput {
  gatewayUrl: string | undefined;
  diagnosticsToken: string | undefined;
  hostname: string;
  endpointKind: SyntheticEndpointKind;
  publicName: string;
}

export interface SyntheticGatewayResult {
  gatewayStatus: number;
  traceId: string | null;
  responseTruncated: boolean;
}

export interface SyntheticGatewayDependencies {
  resolve?: (hostname: string) => Promise<readonly string[]>;
  fetch?: (request: Request, destination: { hostname: string; address: string; family: 4 | 6 }) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function gatewayRequest(endpointKind: SyntheticEndpointKind, publicName: string): { path: string; body: Record<string, unknown> } {
  if (!publicName || publicName.length > 512) {
    throw new SyntheticTestError("SYNTHETIC_POLICY", "route public name is invalid for a synthetic request");
  }
  if (endpointKind === "chat") return {
    path: "/v1/chat/completions",
    body: { model: publicName, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, temperature: 0, stream: false },
  };
  if (endpointKind === "responses") return {
    path: "/v1/responses",
    body: { model: publicName, input: "Reply with OK.", max_output_tokens: 1 },
  };
  return { path: "/v1/embeddings", body: { model: publicName, input: "diagnostic" } };
}

function configuredGateway(input: SyntheticGatewayInput): URL {
  if (!input.gatewayUrl || !input.diagnosticsToken) {
    throw new SyntheticTestError(
      "SYNTHETIC_NOT_CONFIGURED",
      "gateway diagnostics require MANIFOLD_GATEWAY_DIAGNOSTICS_URL and MANIFOLD_GATEWAY_DIAGNOSTICS_TOKEN",
    );
  }
  if (input.diagnosticsToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.diagnosticsToken)) {
    throw new SyntheticTestError("SYNTHETIC_POLICY", "gateway diagnostics token is invalid");
  }
  let base: URL;
  try { base = new URL(input.gatewayUrl); } catch {
    throw new SyntheticTestError("SYNTHETIC_POLICY", "gateway diagnostics URL is malformed");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || (base.pathname !== "" && base.pathname !== "/")) {
    throw new SyntheticTestError("SYNTHETIC_POLICY", "gateway diagnostics URL must be a credential-free HTTPS origin");
  }
  if (base.hostname.toLowerCase() !== input.hostname.toLowerCase()) {
    throw new SyntheticTestError("SYNTHETIC_POLICY", "gateway diagnostics URL hostname is not bound to the selected ingress profile");
  }
  return base;
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function validateDestination(url: URL, hostname: string, resolve: (hostname: string) => Promise<readonly string[]>): Promise<{ hostname: string; address: string; family: 4 | 6 }> {
  const policy = ssrfCheck(url.toString(), [hostname]);
  if (!policy.ok) throw new SyntheticTestError("SYNTHETIC_POLICY", "gateway diagnostics destination is not permitted");
  let addresses: readonly string[];
  try { addresses = await resolve(hostname); } catch { throw new SyntheticTestError("SYNTHETIC_DNS", "gateway diagnostics hostname could not be resolved"); }
  if (!addresses.length || addresses.some((address) => isIP(address) === 0 || isPrivateIp(address))) {
    throw new SyntheticTestError("SYNTHETIC_POLICY", "gateway diagnostics hostname resolved to a blocked network address");
  }
  const address = addresses[0]!;
  return { hostname, address, family: isIP(address) as 4 | 6 };
}

function pinnedFetch(request: Request, destination: { hostname: string; address: string; family: 4 | 6 }): Promise<Response> {
  const url = new URL(request.url);
  const options: RequestOptions = {
    protocol: "https:", hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`,
    method: request.method, headers: Object.fromEntries(request.headers.entries()), servername: url.hostname,
    rejectUnauthorized: true, family: destination.family, signal: request.signal,
    lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
  };
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpsRequest(options, (incoming) => {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index]; const value = incoming.rawHeaders[index + 1];
        if (name && value !== undefined) headers.append(name, value);
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode ?? 502, headers }));
    });
    outgoing.once("error", reject);
    request.arrayBuffer().then((body) => outgoing.end(Buffer.from(body)), reject);
  });
}

async function boundedBody(response: Response, maxBytes: number): Promise<boolean> {
  if (!response.body) return false;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return false;
      total += item.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return true; }
    }
  } finally { reader.releaseLock(); }
}

/**
 * Sends a bounded OpenAI-compatible request through the configured gateway. The control plane
 * never reads, returns, or logs the gateway key or provider response body; callers receive only
 * HTTP outcome and gateway trace id. The URL must be the exact published ingress hostname.
 */
export async function executeSyntheticGatewayRequest(input: SyntheticGatewayInput, dependencies: SyntheticGatewayDependencies = {}): Promise<SyntheticGatewayResult> {
  const base = configuredGateway(input);
  const { path, body } = gatewayRequest(input.endpointKind, input.publicName);
  const url = new URL(path, base);
  const timeoutMs = dependencies.timeoutMs ?? TIMEOUT_MS;
  const maxResponseBytes = dependencies.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new TypeError("synthetic diagnostics bounds must be positive integers");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const destination = await validateDestination(url, base.hostname, dependencies.resolve ?? defaultResolve);
    const request = new Request(url, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { authorization: `Bearer ${input.diagnosticsToken!}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    let response: Response;
    try { response = await (dependencies.fetch ?? pinnedFetch)(request, destination); } catch {
      if (controller.signal.aborted) throw new SyntheticTestError("SYNTHETIC_TIMEOUT", "gateway diagnostic request timed out");
      throw new SyntheticTestError("SYNTHETIC_NETWORK", "gateway diagnostic request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SyntheticTestError("SYNTHETIC_POLICY", "gateway diagnostics does not follow redirects");
    }
    let responseTruncated: boolean;
    try { responseTruncated = await boundedBody(response, maxResponseBytes); } catch {
      if (controller.signal.aborted) throw new SyntheticTestError("SYNTHETIC_TIMEOUT", "gateway diagnostic response timed out");
      throw new SyntheticTestError("SYNTHETIC_NETWORK", "gateway diagnostic response could not be read");
    }
    const trace = response.headers.get("x-trace-id")?.trim() ?? "";
    return { gatewayStatus: response.status, traceId: trace && trace.length <= TRACE_ID_MAX_LENGTH ? trace : null, responseTruncated };
  } finally { clearTimeout(timer); }
}
