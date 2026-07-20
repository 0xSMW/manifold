// handleRequest(ctx, request) — SPEC §8.1 gateway request lifecycle, passthrough scope.
// received → profiled → authenticated → dispatching → streaming → (observation emitted).
// Zero platform imports: only Web-standard Request/Response/Headers/AbortSignal + injected ports.
import type {
  AuthInject,
  BudgetReserver,
  Clock,
  Crypto,
  Fetcher,
  IngestSink,
  ObservationEvent,
  Snapshot,
  SnapshotTarget,
} from "@manifold/ports";
import type { ReasonCode } from "@manifold/contracts";
import { authenticate } from "./authenticate.js";
import { enforceRequest } from "./enforce.js";
import { errorResponse, shapeForCode } from "./errors.js";
import { headerAllowlist, sanitizeResponseHeaders } from "./headers.js";
import { resolveProfile } from "./resolveProfile.js";
import { resolveRoute } from "./resolveRoute.js";
import { selectTarget } from "./selectTarget.js";
import { ssrfCheck, STRICT_SSRF, type SsrfPolicy } from "./ssrf.js";

/** The injected capabilities + loaded snapshot the core runs against (SPEC §4.3). */
export interface GatewayContext {
  installationId: string;
  snapshot: Snapshot;
  crypto: Crypto;
  clock: Clock;
  ingest: IngestSink;
  /** Provider egress. Implementation wraps DNS-pinned SSRF (§14.4). */
  fetcher: Fetcher;
  /** HMAC pepper for key hashing (§14.3). */
  pepper: Uint8Array;
  /**
   * Resolve the fresh provider secret for a target. SKELETON: the adapter reads it from env.
   * TODO(§14.3, ADR-0022): the real path decrypts target.credentialCiphertext in-proc with the
   * KEK-unwrapped DEK via ctx.crypto.openAesGcm — no env, no DB read.
   */
  resolveSecret(target: SnapshotTarget): Promise<string>;
  /** Egress policy. Defaults to strict (https-only, no private addresses). */
  ssrfPolicy?: SsrfPolicy;
  /**
   * Hard-budget reservation port (SPEC §16.3, ADR-0012/§4.4). Injected by the adapter; the core
   * NEVER imports @manifold/budget or a DB driver. Absent ⇒ no key can carry a honored hard budget
   * (a snapshot that marks one then fails closed). Only invoked for a key with a `hard` budget.
   */
  reserveBudget?: BudgetReserver["reserve"];
  /** Deterministic target selection in tests. */
  rand?: () => number;
}

function injectProviderAuth(headers: Headers, authInject: AuthInject, secret: string): void {
  for (const [name, template] of Object.entries(authInject.headers)) {
    headers.set(name.toLowerCase(), template.replaceAll("${secret}", secret));
  }
}

export async function handleRequest(ctx: GatewayContext, request: Request): Promise<Response> {
  const { snapshot } = ctx;
  const traceId = ctx.crypto.randomId("trace");
  const now = ctx.clock.now();
  const url = new URL(request.url);
  const path = url.pathname;

  // Best-effort observation; never blocks or fails the client response (§8.1 public path).
  let seq = 0;
  const emit = (e: Omit<ObservationEvent, "seq" | "occurredAt" | "traceId">): void => {
    const event: ObservationEvent = {
      traceId,
      seq: seq++,
      occurredAt: now.toISOString(),
      ...e,
    };
    void ctx.ingest.emit(event).catch(() => {});
  };

  // Single terminal-emit shape: HTTP status always derives from shapeForCode (the one status map,
  // §0.3) and reasonCodes always carries the code — including synthetic guard codes
  // (SSRF_BLOCKED / CREDENTIAL_UNAVAILABLE / PROFILE_UNKNOWN) that have no reason-registry entry.
  const emitTerminal = (
    code: string,
    ids: {
      profileId?: string;
      keyId?: string | null;
      routeId?: string | null;
      offeringId?: string | null;
    } = {},
  ): void => {
    emit({
      kind: "terminal",
      profileId: ids.profileId ?? "",
      keyId: ids.keyId ?? null,
      routeId: ids.routeId ?? null,
      offeringId: ids.offeringId ?? null,
      status: shapeForCode(code).status,
      reasonCodes: [code as ReasonCode],
    });
  };

  // 1. resolveProfile — pre-auth, from the trusted Host (ADR-0001). Prefer the Host header;
  //    fall back to the URL authority (some runtimes drop the forbidden `host` header).
  const host = request.headers.get("host") ?? url.host;
  const resolved = resolveProfile(host, snapshot);
  if (!resolved) {
    emitTerminal("PROFILE_UNKNOWN");
    return errorResponse("PROFILE_UNKNOWN", "unknown host", traceId);
  }
  const { profileId, profile } = resolved;

  // 2. authenticate — HMAC(key) → snapshot.keys, then revoked/expiry/profile guards.
  const auth = await authenticate(request, profileId, snapshot, ctx.crypto, ctx.pepper, now);
  if (!auth.ok) {
    emitTerminal(auth.reason, { profileId });
    return errorResponse(auth.reason, auth.message, traceId);
  }

  // 3. resolveRoute — O(1) composite key lookup → ROUTE_UNKNOWN.
  const route = resolveRoute(profileId, path, snapshot);
  if (!route) {
    emitTerminal("ROUTE_UNKNOWN", { profileId, keyId: auth.key.id });
    return errorResponse("ROUTE_UNKNOWN", `no route for '${path}' on this endpoint`, traceId);
  }

  // 3.5 ENFORCEMENT (SPEC §11 policy + §16.3 hard budget, review bug #9). After route resolution,
  //     BEFORE target selection / SSRF / dispatch: a denied model or an over-cap hard budget MUST
  //     NOT reach the provider. No-op (body untouched) when the profile carries no policy and the
  //     key has no hard budget. May consume the request body to read model/params + rewrite clamps.
  const enforcement = await enforceRequest({
    snapshot,
    profile,
    key: auth.key,
    request,
    traceId,
    reserveBudget: ctx.reserveBudget,
  });
  if (!enforcement.ok) {
    emitTerminal(enforcement.code, { profileId, keyId: auth.key.id, routeId: route.routeId });
    return errorResponse(enforcement.code, enforcement.message, traceId);
  }

  // 4. selectTarget — ordered/weighted → ROUTE_NO_HEALTHY_TARGET.
  const target = selectTarget(route, ctx.rand);
  if (!target) {
    emitTerminal("ROUTE_NO_HEALTHY_TARGET", { profileId, keyId: auth.key.id, routeId: route.routeId });
    return errorResponse("ROUTE_NO_HEALTHY_TARGET", "no healthy target for route", traceId);
  }

  // 5. Build the upstream URL and enforce SSRF (§14.4).
  const upstreamUrl = new URL(url.pathname + url.search, target.baseUrl).toString();
  const ssrf = ssrfCheck(upstreamUrl, target.allowedHosts, ctx.ssrfPolicy ?? STRICT_SSRF);
  if (!ssrf.ok) {
    emitTerminal("SSRF_BLOCKED", { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId });
    return errorResponse("SSRF_BLOCKED", `egress blocked: ${ssrf.reason}`, traceId);
  }

  // 6. Header allowlist (drops inbound Authorization + hop-by-hop) + fresh provider auth.
  //    resolveSecret decrypts the credential in-proc (§14.3/ADR-0022); if it fails (tamper /
  //    wrong KEK / missing material) we FAIL CLOSED — never dispatch, never leak.
  const upstreamHeaders = headerAllowlist(request.headers);
  let secret: string;
  try {
    secret = await ctx.resolveSecret(target);
  } catch {
    emitTerminal("CREDENTIAL_UNAVAILABLE", { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId });
    return errorResponse("CREDENTIAL_UNAVAILABLE", "provider credential could not be resolved", traceId);
  }
  injectProviderAuth(upstreamHeaders, target.authInject, secret);

  // 7. Dispatch with a bounded timeout; stream the body straight through (no buffering).
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: upstreamHeaders,
    signal: AbortSignal.timeout(route.timeoutMs),
  };
  if (hasBody) {
    if (enforcement.forwardBody !== undefined) {
      // Enforcement buffered the request body to read model/params (and may have rewritten a
      // policy clamp); the original stream is consumed, so forward the buffered string.
      init.body = enforcement.forwardBody;
    } else {
      // Fast path (no policy, no hard budget): stream the request body straight through, no buffer.
      init.body = request.body;
      init.duplex = "half";
    }
  }
  const upstreamReq = new Request(upstreamUrl, init);

  let upstream: Response;
  try {
    upstream = await ctx.fetcher.fetch(upstreamReq);
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const code = isTimeout ? "PROVIDER_TIMEOUT" : "PROVIDER_HTTP_5XX";
    emitTerminal(code, { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId });
    return errorResponse(code, isTimeout ? "upstream timed out" : "upstream request failed", traceId);
  }

  // 8. Response started: emit the observation, then relay the stream with flat memory.
  emit({
    kind: "accepted",
    profileId,
    keyId: auth.key.id,
    routeId: route.routeId,
    offeringId: target.offeringId,
    status: upstream.status,
    reasonCodes: [],
  });

  const responseHeaders = sanitizeResponseHeaders(upstream.headers);
  responseHeaders.set("x-trace-id", traceId);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
