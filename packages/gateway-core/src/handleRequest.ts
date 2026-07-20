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
  ObservationUsage,
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

/**
 * Upper bound on a response body we will BUFFER to read its `usage` block. A small,
 * declared-JSON, sub-limit response (a non-streamed chat/messages completion) is buffered so the
 * terminal observation carries real token counts (§8.3). Anything larger or non-JSON — including a
 * streamed SSE completion or a 1GB passthrough — is relayed with flat memory and NOT parsed here;
 * SSE final-usage capture (reading the terminal `message_delta` / `[DONE]` usage frame off the
 * stream) is the documented FOLLOW-UP. 256 KiB comfortably covers a JSON completion envelope.
 */
const USAGE_CAPTURE_MAX_BYTES = 256 * 1024;

/** True iff `upstream` is a small, self-described-JSON body we may buffer to read `usage`. */
function isBufferableJson(upstream: Response): boolean {
  const ct = upstream.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) return false;
  // Do NOT trust content-length for a COMPRESSED body (review HIGH #7 — decompression bomb): undici
  // transparently decompresses on `.text()`, so a gzip/br/deflate response with a small on-wire
  // content-length can decode to hundreds of MB / GB. Treat a content-encoded body as a stream (relay,
  // no buffer, no usage) rather than buffer an unbounded decoded payload into memory.
  const enc = (upstream.headers.get("content-encoding") ?? "").toLowerCase().trim();
  if (enc && enc !== "identity") return false;
  const lenHeader = upstream.headers.get("content-length");
  if (lenHeader === null) return false; // unknown length ⇒ treat as a stream, never buffer
  const len = Number(lenHeader);
  return Number.isFinite(len) && len >= 0 && len <= USAGE_CAPTURE_MAX_BYTES;
}

/** Coerce a provider-usage field (number, or numeric string) to a non-negative integer, else undefined. */
function usageNum(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * Extract token counts from a parsed completion body's `usage` block (§8.3). Provider-agnostic:
 * accepts the Anthropic shape (`input_tokens`/`output_tokens`/`cache_*_input_tokens`) and the
 * OpenAI shape (`prompt_tokens`/`completion_tokens` + `*_tokens_details`). Returns `undefined`
 * when there is no recognizable usage, so the terminal simply carries no counts (cost µ$0).
 */
function parseUsageBlock(body: unknown): ObservationUsage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const u = (body as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return undefined;
  const r = u as Record<string, unknown>;
  const promptDetails = r.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = r.completion_tokens_details as Record<string, unknown> | undefined;
  const usage: ObservationUsage = {};
  const set = (k: keyof ObservationUsage, v: number | undefined): void => {
    if (v !== undefined) usage[k] = v;
  };
  set("inputTokens", usageNum(r.input_tokens) ?? usageNum(r.prompt_tokens));
  set("outputTokens", usageNum(r.output_tokens) ?? usageNum(r.completion_tokens));
  set(
    "cacheReadTokens",
    usageNum(r.cache_read_input_tokens) ?? usageNum(promptDetails?.cached_tokens),
  );
  set("cacheWriteTokens", usageNum(r.cache_creation_input_tokens));
  set(
    "reasoningTokens",
    usageNum(r.reasoning_tokens) ?? usageNum(completionDetails?.reasoning_tokens),
  );
  set("audioInputTokens", usageNum(r.audio_input_tokens));
  set("audioOutputTokens", usageNum(r.audio_output_tokens));
  return Object.keys(usage).length > 0 ? usage : undefined;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode a 48-bit millisecond timestamp as a ULID's 10-char Crockford-base32 time prefix. */
function encodeUlidTime(ms: number): string {
  let out = "";
  let n = Math.floor(ms);
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/**
 * Mint the trace id as a REAL ULID (SPEC §6.7 B1, §16.3): its 10-char time prefix is `nowMs`, so
 * `ulidCreatedAt` decodes it back to the request instant — giving the hard-budget reservation an
 * accurate created_at (and the right monthly partition) instead of throwing on a `trace_<hex>` that
 * is NOT a ULID. The 16 random chars are sourced from the crypto port (gateway-core stays pure — no
 * @manifold/budget import); a ULID is itself a valid trace id and the reservation idempotency anchor.
 */
function mintTraceUlid(crypto: Crypto, nowMs: number): string {
  const entropy = crypto.randomId("t"); // prefixed random hex; sample its chars as a random source
  let rand = "";
  for (let i = 0; i < 16; i++) {
    const code = entropy.charCodeAt(entropy.length - 1 - i) || i * 31 + 7;
    rand += CROCKFORD[code % 32]!;
  }
  return encodeUlidTime(nowMs) + rand;
}

export async function handleRequest(ctx: GatewayContext, request: Request): Promise<Response> {
  const { snapshot } = ctx;
  const now = ctx.clock.now();
  const traceId = mintTraceUlid(ctx.crypto, now.getTime());
  const url = new URL(request.url);
  const path = url.pathname;

  // Best-effort observation; never blocks or fails the client response (§8.1 public path).
  let seq = 0;
  const emit = (e: Omit<ObservationEvent, "seq" | "occurredAt" | "traceId">): void => {
    const event: ObservationEvent = {
      traceId,
      seq: seq++,
      // Stamp occurredAt per-event at emit time (NOT the single request-start `now`), so
      // latency/time-windowing survives: accepted and terminal carry distinct instants (§8.3).
      occurredAt: ctx.clock.now().toISOString(),
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
      /** Live hard-budget hold to release on the reconcile path (review gateway-F5/#2). */
      reservationId?: string | null;
      budgetAccountId?: string | null;
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
      // A post-reserve failure MUST still carry the reservation id so ingest commits/releases the hold
      // (at $0 actual — the request never dispatched) instead of stranding it until the expiry sweep.
      ...(ids.reservationId ? { reservationId: ids.reservationId } : {}),
      ...(ids.budgetAccountId ? { budgetAccountId: ids.budgetAccountId } : {}),
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

  // 2. authenticate — HMAC(key) → snapshot.keys, then expiry/profile guards (revoked keys are
  //    filtered out of the snapshot at build, F10, so they resolve to AUTH_KEY_UNKNOWN here).
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

  // 4. selectTarget — ordered/weighted → ROUTE_NO_HEALTHY_TARGET. Selected BEFORE enforcement so
  //    the hard-budget reserve can price its estimate against the ACTUAL dispatch target's offering
  //    (§6.10) — the reservation must reflect the provider the request will really hit.
  const target = selectTarget(route, ctx.rand);
  if (!target) {
    emitTerminal("ROUTE_NO_HEALTHY_TARGET", { profileId, keyId: auth.key.id, routeId: route.routeId });
    return errorResponse("ROUTE_NO_HEALTHY_TARGET", "no healthy target for route", traceId);
  }

  // 4.5 ENFORCEMENT (SPEC §11 policy + §16.3 hard budget, review bug #9). After route + target
  //     resolution, BEFORE SSRF / dispatch: a denied model or an over-cap hard budget MUST NOT reach
  //     the provider. No-op (body untouched) when the profile carries no policy and the key has no
  //     hard budget. May consume the request body to read model/params + rewrite clamps.
  const enforcement = await enforceRequest({
    snapshot,
    profile,
    key: auth.key,
    request,
    traceId,
    target,
    reserveBudget: ctx.reserveBudget,
  });
  if (!enforcement.ok) {
    emitTerminal(enforcement.code, { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId });
    return errorResponse(enforcement.code, enforcement.message, traceId);
  }

  // A hard-budget reservation may now be HELD (enforcement.reservationId). Thread it onto EVERY
  // subsequent terminal — the success path AND the post-reserve failure paths (SSRF / credential /
  // dispatch error) — so the reconcile ALWAYS releases the hold (review gateway-F5/#2). Without this
  // the hold is orphaned until the (unwired) expiry sweep: a valid key that forces deterministic
  // post-reserve failures could accumulate holds to the cap and deny a tenant's real traffic.
  const reservationId = enforcement.reservationId ?? null;
  const budgetAccountId = auth.key.budgetAccountId;

  // 5. Build the upstream URL and enforce SSRF (§14.4).
  const upstreamUrl = new URL(url.pathname + url.search, target.baseUrl).toString();
  const ssrf = ssrfCheck(upstreamUrl, target.allowedHosts, ctx.ssrfPolicy ?? STRICT_SSRF);
  if (!ssrf.ok) {
    emitTerminal("SSRF_BLOCKED", { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId, reservationId, budgetAccountId });
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
    emitTerminal("CREDENTIAL_UNAVAILABLE", { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId, reservationId, budgetAccountId });
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
    // undici throws TypeError('fetch failed') with the real reason on `err.cause` — an
    // AbortSignal.timeout() surfaces as cause.name==='TimeoutError', NOT as a top-level
    // DOMException. Check both the cause and the (spec) direct DOMException so
    // AbortSignal.timeout maps to PROVIDER_TIMEOUT (504) rather than a generic 5xx.
    const cause = (err as { cause?: { name?: string } }).cause;
    const isTimeout =
      (err instanceof DOMException && err.name === "TimeoutError") || cause?.name === "TimeoutError";
    // The EgressFetcher performs a post-DNS SSRF recheck and throws Error('egress: …') when a
    // hostname resolves to a private address (DNS-rebind defense, §14.4). Map that to
    // SSRF_BLOCKED (403), not a provider 5xx — it is a safety block, not an upstream failure.
    const isEgressBlocked = err instanceof Error && err.message.startsWith("egress:");
    const code = isEgressBlocked
      ? "SSRF_BLOCKED"
      : isTimeout
        ? "PROVIDER_TIMEOUT"
        : "PROVIDER_HTTP_5XX";
    const message = isEgressBlocked
      ? "egress blocked: destination not permitted"
      : isTimeout
        ? "upstream timed out"
        : "upstream request failed";
    emitTerminal(code, { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId, reservationId, budgetAccountId });
    return errorResponse(code, message, traceId);
  }

  // 8. Response started: emit the observation, then relay the body (flat memory unless we buffer
  //    a SMALL json completion to capture usage — see below).
  emit({
    kind: "accepted",
    profileId,
    keyId: auth.key.id,
    routeId: route.routeId,
    offeringId: target.offeringId,
    status: upstream.status,
    reasonCodes: [],
  });

  // Dispatch-time price + provenance the terminal stamps for cost (§6.10): resolved from the
  // snapshot's offerings section for THIS offering, so cost uses the price in force when the
  // request ran (absent ⇒ no price → projected µ$0, unknown fidelity).
  const offering = snapshot.offerings?.[target.offeringId];
  const price = offering?.price;
  const priceRevisionId = offering?.priceRevisionId ?? null;

  // USAGE CAPTURE (§8.3): buffer ONLY a small, self-described-JSON completion to read its `usage`
  // block. A streamed / large / non-JSON body is relayed straight through with flat memory and the
  // terminal carries no usage; SSE final-usage capture is the documented follow-up. This preserves
  // the 1GB flat-memory guarantee.
  let responseBody: BodyInit | null = upstream.body;
  let usage: ObservationUsage | undefined;
  if (isBufferableJson(upstream)) {
    const bodyText = await upstream.text(); // bounded by content-length ≤ USAGE_CAPTURE_MAX_BYTES
    responseBody = bodyText; // re-emit the buffered bytes; the client sees the identical body
    try {
      usage = parseUsageBlock(JSON.parse(bodyText) as unknown);
    } catch {
      usage = undefined; // unparseable JSON ⇒ no usage, still a clean passthrough
    }
  }

  // Terminal event for the success path. Observability's reduce() treats a trace with no terminal
  // as incomplete (→ $0 cost), so EVERY request — including a 200 dispatch — MUST end with a
  // terminal (§8.3). When usage was captured it carries the token counts + dispatch price +
  // price-revision + reservation, so the projection writes a real cost_ledger row and reconciles
  // the hold reserved→committed (§6.9/§8.4).
  emit({
    kind: "terminal",
    profileId,
    keyId: auth.key.id,
    routeId: route.routeId,
    offeringId: target.offeringId,
    status: upstream.status,
    reasonCodes: [],
    ...(usage ? { usage } : {}),
    ...(usage && price ? { price } : {}),
    ...(usage ? { priceRevisionId } : {}),
    budgetAccountId,
    // ALWAYS carry the reservation id (review gateway-F5/#2): when usage was captured the reconcile
    // commits the ACTUAL cost; on a STREAMED success (no usage) it still commits (at $0) so the hold
    // is released now, not stranded until the sweep. Streamed-spend accuracy (SSE usage capture) is
    // the documented follow-up — this closes the headroom LEAK, not the under-count.
    ...(reservationId ? { reservationId } : {}),
  });

  const responseHeaders = sanitizeResponseHeaders(upstream.headers);
  responseHeaders.set("x-trace-id", traceId);
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
