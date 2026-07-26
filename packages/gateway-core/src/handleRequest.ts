// handleRequest(ctx, request) — SPEC §8.1 gateway request lifecycle, passthrough scope.
// received → profiled → authenticated → dispatching → streaming → (observation emitted).
// Zero platform imports: only Web-standard Request/Response/Headers/AbortSignal + injected ports.
import type {
  AuthInject,
  BudgetReserver,
  Clock,
  Crypto,
  Fetcher,
  HotPathObservationEvent,
  IngestSink,
  ObservationUsage,
  Snapshot,
  SnapshotTarget,
} from "@manifold/ports";
import type { ReasonCode } from "@manifold/contracts";
import { ulidFromEntropy } from "@manifold/ids";
import { authenticate } from "./authenticate.js";
import { decodeOpenAiRequest, RequestCodecError, toOpenAiProviderRequest } from "./codecs.js";
import type { DistributedAdmission } from "./distributedAdmission.js";
import type {
  CircuitFailure,
  CircuitTargetInput,
  LocalCircuitBreaker,
} from "./circuitBreaker.js";
import { enforceRequest } from "./enforce.js";
import { errorResponse, shapeForCode } from "./errors.js";
import { headerAllowlist, sanitizeResponseHeaders } from "./headers.js";
import { normalizeProviderErrorResponse } from "./providerErrors.js";
import { resolveProfile } from "./resolveProfile.js";
import { resolveRoute, routeKey } from "./resolveRoute.js";
import { decideRetry, orderTargetAttempts, retryPolicyFromSnapshot, snapshotTargetIdentity } from "./retry.js";
import {
  limitRequestBody,
  type ConcurrencyDecision,
} from "./runtimeLimits.js";
import { selectTarget } from "./selectTarget.js";
import {
  createSseUsageTransform,
  type SseUsageTransform,
} from "./sseUsage.js";
import {
  noopTelemetry,
  startRequestTelemetry,
  type GatewayEndpoint,
  type TelemetryReason,
} from "./telemetry.js";
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
  /** Optional rotation overlap. When supplied, order is new then old and at most two are used. */
  peppers?: readonly Uint8Array[];
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
  /** Fast key-level admission guard. The Vercel adapter supplies a bounded per-isolate limiter. */
  rateLimit?: (input: {
    installationId: string;
    virtualKeyId: string;
    estimatedTokens: number;
    rpm?: number;
    tpm?: number;
    burst?: number;
  }) => { allowed: boolean; retryAfterSeconds: number };
  /**
   * Strict distributed request/rate/concurrency authority. When configured it is the sole
   * admission authority: local rate and concurrency guards are intentionally bypassed.
   */
  distributedAdmission?: DistributedAdmission;
  /** Runtime request-size ceiling. The Vercel adapter sets this below the platform cap. */
  maxRequestBytes?: number;
  /** Bounded concurrency admission. A grant is held until the returned response stream settles. */
  acquireConcurrency?: (input: {
    installationId: string;
    virtualKeyId: string;
  }) => ConcurrencyDecision;
  /** Fast per-isolate circuit signal layered under the signed/durable target health state. */
  circuitBreaker?: Pick<LocalCircuitBreaker, "allow" | "recordSuccess" | "recordFailure">;
  /** OpenTelemetry-compatible tracing/metrics/log adapter. */
  telemetry?: import("./telemetry.js").Telemetry;
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
/** A second, much smaller bound for durable observation capture envelopes. */
const OBSERVATION_CAPTURE_MAX_BYTES = 4 * 1024;
type SnapshotCapturePolicy = { mode: "none" | "metadata" | "redacted" | "full"; maxBytes: number };
type ObservationCapture = { mode: "redacted" | "full"; request?: Record<string, unknown>; response?: Record<string, unknown>; truncated?: boolean; bytes: number };

/** Whether an upstream response is JSON we may inspect without a decompression-bomb risk. */
function isInspectableJson(upstream: Response): boolean {
  const ct = upstream.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) return false;
  // Do NOT trust content-length for a COMPRESSED body (review HIGH #7 — decompression bomb): undici
  // transparently decompresses on `.text()`, so a gzip/br/deflate response with a small on-wire
  // content-length can decode to hundreds of MB / GB. Treat a content-encoded body as a stream (relay,
  // no buffer, no usage) rather than buffer an unbounded decoded payload into memory.
  const enc = (upstream.headers.get("content-encoding") ?? "").toLowerCase().trim();
  return !enc || enc === "identity";
}

/** True iff a declared JSON response is small enough to buffer outright for exact usage. */
function isBufferableJson(upstream: Response): boolean {
  if (!isInspectableJson(upstream)) return false;
  const lenHeader = upstream.headers.get("content-length");
  if (lenHeader === null) return false;
  const len = Number(lenHeader);
  return Number.isFinite(len) && len >= 0 && len <= USAGE_CAPTURE_MAX_BYTES;
}

type BoundedJsonCapture =
  | { captured: true; body: Uint8Array }
  | { captured: false; body: ReadableStream<Uint8Array> };

/**
 * Consume an unknown-length JSON body only until it is proven larger than the usage-capture cap.
 * A bounded body is returned byte-for-byte for parsing and replay. On overflow, the already-read
 * prefix and the live reader are exposed as a replay stream, so the client receives every original
 * byte while telemetry retains no unbounded body buffer.
 */
async function captureUnknownLengthJson(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<BoundedJsonCapture> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { captured: true, body };
    }
    const chunk = next.value;
    if (total + chunk.byteLength <= maxBytes) {
      chunks.push(chunk);
      total += chunk.byteLength;
      continue;
    }

    // Keep only the <= cap prefix. The overflow chunk is emitted directly by the replay stream
    // and is never copied into telemetry storage; the reader remains owned by that response body.
    let overflow: Uint8Array | undefined = chunk;
    const replay = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunks.length > 0) {
          controller.enqueue(chunks.shift()!);
          return;
        }
        if (overflow) {
          controller.enqueue(overflow);
          overflow = undefined;
          return;
        }
        const later = await reader.read();
        if (later.done) controller.close();
        else controller.enqueue(later.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return { captured: false, body: replay };
  }
}

function capturePolicyForRoute(policy: SnapshotCapturePolicy | undefined): { mode: "redacted" | "full"; maxBytes: number } | undefined {
  if (!policy || (policy.mode !== "redacted" && policy.mode !== "full")) return undefined;
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1) return undefined;
  return { mode: policy.mode as "redacted" | "full", maxBytes: Math.min(policy.maxBytes, OBSERVATION_CAPTURE_MAX_BYTES) };
}

function objectCapture(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const CAPTURE_SECRET_KEY = /(?:authorization|api[_.-]?key|token|secret|password|credential|cookie|session|private[_.-]?key)/i;
const CAPTURE_SECRET_VALUE = /(?:\b(?:bearer|basic)\s+\S+|\bsk-[a-z0-9_-]+|\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+)/i;
function redactCaptureValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return (CAPTURE_SECRET_VALUE.test(value) ? "[REDACTED]" : value).slice(0, 256);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactCaptureValue(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 64)
    .map(([key, child]) => [key, CAPTURE_SECRET_KEY.test(key) ? "[REDACTED]" : redactCaptureValue(child, depth + 1)]));
  return null;
}

/**
 * The core has already bounded request parsing and response buffering. Keep the durable tee
 * envelope independently bounded so a permissive route policy cannot turn telemetry into an
 * unbounded body store. On overflow retain only a truthful marker, never a partial raw payload.
 */
export function boundedObservationCapture(
  policy: SnapshotCapturePolicy | undefined,
  request: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
): ObservationCapture | undefined {
  const effective = capturePolicyForRoute(policy);
  if (!effective || (!request && !response)) return undefined;
  const payload = { ...(request ? { request } : {}), ...(response ? { response } : {}) };
  const protectedPayload = effective.mode === "redacted" ? redactCaptureValue(payload) as typeof payload : payload;
  const bytes = new TextEncoder().encode(JSON.stringify(protectedPayload)).byteLength;
  // `capture` itself crosses the ingest boundary, not merely its request/response payload.
  // Account for mode, bytes, and any future envelope fields here so the gateway never emits a
  // value the closed ObservationIngestRequest contract will reject.  On either policy or
  // transport overflow retain no partial raw body: the terminal marker is intentionally small,
  // truthful, and accepted by the same contract.
  const capture = { mode: effective.mode, ...protectedPayload, bytes };
  const transportBytes = new TextEncoder().encode(JSON.stringify(capture)).byteLength;
  if (bytes > effective.maxBytes || transportBytes > OBSERVATION_CAPTURE_MAX_BYTES) {
    return { mode: effective.mode, truncated: true, bytes: 0 };
  }
  return capture;
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

/**
 * Mint the trace id as a REAL ULID (SPEC §6.7 B1, §16.3) via the ONE shared id vocabulary
 * (`@manifold/ids`): its 10-char time prefix is `nowMs`, so `ulidCreatedAt` decodes it back to the
 * request instant — giving the hard-budget reservation an accurate created_at (and the right monthly
 * partition) instead of throwing on a `trace_<hex>` that is NOT a ULID. The 16 random chars are
 * sourced from the crypto port (gateway-core stays pure — `@manifold/ids` is a zero-dep leaf, so this
 * imports NO @manifold/budget and NO driver); a ULID is itself a valid trace id and the reservation
 * idempotency anchor.
 */
function mintTraceUlid(crypto: Crypto, nowMs: number): string {
  return ulidFromEntropy(nowMs, crypto.randomId("t"));
}

function estimateRateLimitTokens(body: Record<string, unknown> | undefined): number {
  if (!body) return 0;
  const requested = usageNum(body.max_tokens) ?? usageNum(body.max_output_tokens) ?? 0;
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4) + requested);
}

/**
 * Exposes an observed provider stream while making downstream cancellation visible to the
 * accounting observer. The observer's onFinalize hook is awaited before close/error/cancel
 * settles, so a terminal intent cannot be silently abandoned with the stream.
 */
function relayObservedStream(
  source: ReadableStream<Uint8Array>,
  observer: SseUsageTransform,
): ReadableStream<Uint8Array> {
  const reader = source.pipeThrough(observer.stream).getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        observer.abort();
        await observer.result.catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      observer.abort();
      await reader.cancel(reason);
      await observer.result;
    },
  });
}

type ResponseSettlement = "complete" | "cancelled" | "error";

/** Run a finalizer only when the response body is finished, errors, or is cancelled. */
function finalizeWithResponse(
  response: Response,
  finalize: (settlement: ResponseSettlement) => void | Promise<void>,
): Promise<Response> {
  if (!response.body) {
    return Promise.resolve(finalize("complete")).then(() => response);
  }
  const reader = response.body.getReader();
  let finalization: Promise<void> | undefined;
  const finalizeOnce = (settlement: ResponseSettlement): Promise<void> => {
    if (!finalization) finalization = Promise.resolve(finalize(settlement));
    return finalization;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await finalizeOnce("complete");
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        await finalizeOnce("error").catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finalizeOnce("cancelled");
      }
    },
  });
  return Promise.resolve(new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
}

function circuitTarget(installationId: string, target: SnapshotTarget): CircuitTargetInput {
  return {
    installationId,
    targetId: snapshotTargetIdentity(target),
  };
}

function telemetryReasonForStatus(status: number): TelemetryReason | undefined {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return undefined;
}

function attemptOutcomeForStatus(status: number): "success" | "transient_failure" | "permanent_failure" {
  if (status >= 200 && status < 400) return "success";
  // 408/429 and all 5xx responses are retryable provider-side conditions.
  if (status === 408 || status === 429 || status >= 500) return "transient_failure";
  return "permanent_failure";
}

/**
 * Join a client OpenAI path onto a provider's configured API root.
 *
 * Gateway clients always address OpenAI-compatible endpoints below `/v1`. A provider base URL
 * may instead include its own API prefix (for example Gemini's `/v1beta/openai/`). URL's normal
 * resolution would discard that prefix when given an absolute client path, so retain the base
 * pathname and remove the client-side OpenAI version segment only when a non-root API prefix is
 * configured. The client query is authoritative for the upstream request.
 */
function upstreamUrlFor(baseUrl: string, clientPathname: string, clientSearch: string): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  let clientPath = clientPathname.replace(/^\/+/, "");
  if (basePath && /^v1(?:\/|$)/.test(clientPath)) {
    clientPath = clientPath.slice(2).replace(/^\/+/, "");
  }
  base.pathname = `${basePath}/${clientPath}`.replace(/\/{2,}/g, "/");
  base.search = clientSearch;
  base.hash = "";
  return base.toString();
}

export async function handleRequest(ctx: GatewayContext, request: Request): Promise<Response> {
  const { snapshot } = ctx;
  const now = ctx.clock.now();
  const traceId = mintTraceUlid(ctx.crypto, now.getTime());
  const url = new URL(request.url);
  const path = url.pathname;
  const telemetryLifecycle = startRequestTelemetry(
    ctx.telemetry ?? noopTelemetry,
    { installationId: ctx.installationId },
    () => performance.now(),
  );
  let telemetryProfileId: string | undefined;
  let telemetryRouteId: string | undefined;
  let telemetryEndpoint: GatewayEndpoint = "unknown";
  let telemetryRetryCount = 0;
  let telemetryFailoverCount = 0;
  let telemetryStreamAborted = false;
  const endTelemetry = (statusCode: number, settlement: ResponseSettlement): void => {
    const cancelled = settlement === "cancelled";
    const errored = settlement === "error" || telemetryStreamAborted;
    telemetryLifecycle.end({
      outcome: cancelled ? "cancelled" : errored || statusCode >= 500 ? "error" : statusCode >= 400 ? "rejected" : "success",
      statusCode,
      ...(telemetryProfileId ? { profileId: telemetryProfileId } : {}),
      ...(telemetryRouteId ? { routeId: telemetryRouteId } : {}),
      endpoint: telemetryEndpoint,
      ...(telemetryStreamAborted
        ? { reason: "stream_aborted" }
        : telemetryReasonForStatus(statusCode)
          ? { reason: telemetryReasonForStatus(statusCode)! }
          : {}),
      retryCount: telemetryRetryCount,
      failoverCount: telemetryFailoverCount,
    });
  };

  // Observations from one request must arrive in sequence order. Keep the tail recoverable so a
  // failed best-effort write does not prevent a later terminal attempt, while remembering that
  // failure for a reserved request: a response with a hard-budget hold cannot be released as
  // successfully accounted when either accepted or terminal persistence failed.
  let seq = 0;
  let ingestChain: Promise<void> = Promise.resolve();
  let ingestFailure: unknown;
  let hasIngestFailure = false;
  const enqueue = (e: Omit<HotPathObservationEvent, "seq" | "occurredAt" | "traceId">): Promise<void> => {
    const event: HotPathObservationEvent = {
      traceId,
      seq: seq++,
      // Stamp occurredAt per-event at emit time (NOT the single request-start `now`), so
      // latency/time-windowing survives: accepted and terminal carry distinct instants (§8.3).
      occurredAt: ctx.clock.now().toISOString(),
      ...e,
    };
    const delivery = ingestChain.then(() => ctx.ingest.emit(event));
    // The next event must still be delivered after a failed best-effort event. Record the first
    // error so a hard-budget terminal can make the request fail rather than silently succeeding.
    ingestChain = delivery.catch((error: unknown) => {
      if (!hasIngestFailure) {
        hasIngestFailure = true;
        ingestFailure = error;
      }
    });
    return delivery;
  };
  const emit = (e: Omit<HotPathObservationEvent, "seq" | "occurredAt" | "traceId">): void => {
    // Public/non-money observations deliberately remain off the response path. Attach a handler
    // immediately so their failures are observed without becoming unhandled rejections.
    void enqueue(e).catch(() => {});
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
  ): Promise<void> => {
    const delivery = enqueue({
      kind: "terminal",
      profileId: ids.profileId ?? "",
      keyId: ids.keyId ?? null,
      routeId: ids.routeId ?? null,
      offeringId: ids.offeringId ?? null,
      status: shapeForCode(code).status,
      reasonCodes: [code as ReasonCode],
      // A post-reserve failure MUST still carry the reservation id so ingest commits/releases the hold
      // (at $0 actual — the request never dispatched) instead of stranding it until the expiry sweep.
      ...(ids.reservationId !== null && ids.reservationId !== undefined ? { reservationId: ids.reservationId } : {}),
      ...(ids.budgetAccountId ? { budgetAccountId: ids.budgetAccountId } : {}),
    });
    if (ids.reservationId === null || ids.reservationId === undefined) {
      // A terminal before reservation has the same public best-effort semantics as every other
      // observation. Do not make an auth/policy/etc. response wait for ingest.
      void delivery.catch(() => {});
      return Promise.resolve();
    }
    return delivery.then(() => {
      // `delivery` reports this terminal's write; the recorded error also covers a prior accepted
      // write that failed before this terminal was serialized behind it.
      if (hasIngestFailure) throw ingestFailure;
    });
  };

  // 1. resolveProfile — pre-auth, from the trusted Host (ADR-0001). Prefer the Host header;
  //    fall back to the URL authority (some runtimes drop the forbidden `host` header).
  const host = request.headers.get("host") ?? url.host;
  const resolved = resolveProfile(host, snapshot);
  if (!resolved) {
    emitTerminal("PROFILE_UNKNOWN");
    const response = errorResponse("PROFILE_UNKNOWN", "unknown host", traceId);
    endTelemetry(response.status, "complete");
    return response;
  }
  const { profileId, profile } = resolved;
  telemetryProfileId = profileId;

  // 2. authenticate — HMAC(key) → snapshot.keys, then expiry/profile guards (revoked keys are
  //    filtered out of the snapshot at build, F10, so they resolve to AUTH_KEY_UNKNOWN here).
  const auth = await authenticate(request, profileId, snapshot, ctx.crypto, ctx.peppers ?? ctx.pepper, now);
  if (!auth.ok) {
    emitTerminal(auth.reason, { profileId });
    const response = errorResponse(auth.reason, auth.message, traceId);
    endTelemetry(response.status, "complete");
    return response;
  }

  // A distributed authority owns the complete admission decision. Retain the legacy bounded
  // local concurrency guard only when that authority is absent, so the two sources never create
  // conflicting limits for one request.
  const concurrency = ctx.distributedAdmission
    ? undefined
    : ctx.acquireConcurrency?.({
      installationId: ctx.installationId,
      virtualKeyId: auth.key.id,
    });
  if (concurrency && !concurrency.allowed) {
    emitTerminal("RATE_LIMIT_KEY", { profileId, keyId: auth.key.id });
    const response = errorResponse("RATE_LIMIT_KEY", "concurrency limit exceeded", traceId);
    response.headers.set("retry-after", String(concurrency.retryAfterSeconds));
    endTelemetry(response.status, "complete");
    return response;
  }
  let releaseDistributed: (() => Promise<void>) | undefined;
  let admissionRelease: Promise<void> | undefined;
  const releaseAdmission = (): Promise<void> => {
    if (!admissionRelease) {
      admissionRelease = (async () => {
        await releaseDistributed?.();
        concurrency?.allowed && concurrency.release();
      })();
    }
    return admissionRelease;
  };
  const respond = (response: Response): Promise<Response> => finalizeWithResponse(response, async (settlement) => {
    await releaseAdmission();
    endTelemetry(response.status, settlement);
  });

  try {
  if (ctx.maxRequestBytes !== undefined) {
    const limited = await limitRequestBody(request, { maxBytes: ctx.maxRequestBytes });
    if (!limited.allowed) {
      emitTerminal("POLICY_BODY_TOO_LARGE", { profileId, keyId: auth.key.id });
      return respond(errorResponse(
        "POLICY_BODY_TOO_LARGE",
        `request body exceeds the ${limited.limitBytes}-byte limit`,
        traceId,
      ));
    }
    request = limited.request;
  }

  // 3. Decode the bounded OpenAI-compatible request before route lookup. This makes the public
  // model part of the signed-snapshot key while retaining a replayable request for enforcement.
  let decoded;
  let legacyPathRoute = false;
  try {
    decoded = await decodeOpenAiRequest(request);
  } catch (error) {
    const codec = error instanceof RequestCodecError
      ? error
      : new RequestCodecError(400, "REQUEST_JSON_MALFORMED", "request could not be decoded");
    // Migration compatibility for pre-§21 endpoint adapters such as /v1/messages. Their signed
    // snapshots remain keyed by path and their provider-native body is already in dispatch shape.
    if (codec.code === "ROUTE_ENDPOINT_UNSUPPORTED") {
      legacyPathRoute = true;
      decoded = {
        endpointKind: path,
        publicModel: undefined,
        body: undefined,
        request,
      };
    } else {
      emitTerminal(codec.code, { profileId, keyId: auth.key.id });
      return respond(errorResponse(codec.code, codec.message, traceId));
    }
  }
  if (
    decoded.endpointKind === "chat" ||
    decoded.endpointKind === "responses" ||
    decoded.endpointKind === "embeddings" ||
    decoded.endpointKind === "models"
  ) {
    telemetryEndpoint = decoded.endpointKind as GatewayEndpoint;
  }

  // Decode first so token estimation has a bounded, replayable body. This admission applies to
  // every authenticated endpoint, including the zero-token local /v1/models registry view.
  let distributedGrantSignal: AbortSignal | undefined;
  if (ctx.distributedAdmission) {
    let admission;
    try {
      admission = await ctx.distributedAdmission({
        installationId: ctx.installationId,
        virtualKeyId: auth.key.id,
        traceId,
        estimatedTokens: decoded.endpointKind === "models" ? 0 : estimateRateLimitTokens(decoded.body),
        ...(auth.key.rateLimit ? { rateLimit: auth.key.rateLimit } : {}),
      });
    } catch {
      emitTerminal("RATE_LIMIT_KEY", { profileId, keyId: auth.key.id });
      const response = errorResponse("RATE_LIMIT_KEY", "admission authority is unavailable", traceId);
      response.headers.set("retry-after", "1");
      return respond(response);
    }
    if (!admission.allowed) {
      emitTerminal("RATE_LIMIT_KEY", { profileId, keyId: auth.key.id });
      const response = errorResponse("RATE_LIMIT_KEY", "admission denied", traceId);
      response.headers.set("retry-after", String(admission.retryAfterSeconds));
      return respond(response);
    }
    releaseDistributed = admission.release;
    distributedGrantSignal = admission.signal;
  }

  // /v1/models is a profile-scoped registry view assembled from the active signed snapshot. It
  // never dispatches to a provider and therefore does not require a synthetic route or credential.
  if (decoded.endpointKind === "models") {
    const prefix = `${profileId}:`;
    const ids = Object.keys(snapshot.routes)
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).startsWith("/"))
      .map((key) => key.split(":").slice(2).join(":"))
      .filter((id) => id.length > 0);
    const unique = [...new Set(ids)].sort();
    const created = Math.floor(new Date(snapshot.meta.builtAt).getTime() / 1000);
    void enqueue({
      kind: "terminal",
      profileId,
      keyId: auth.key.id,
      routeId: null,
      offeringId: null,
      status: 200,
      reasonCodes: [],
    }).catch(() => {});
    return respond(new Response(JSON.stringify({
      object: "list",
      data: unique.map((id) => ({ id, object: "model", created, owned_by: "manifold" })),
    }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-trace-id": traceId,
      },
    }));
  }

  if (!ctx.distributedAdmission && auth.key.rateLimit) {
    if (!ctx.rateLimit) {
      emitTerminal("RATE_LIMIT_KEY", { profileId, keyId: auth.key.id });
      return respond(errorResponse("RATE_LIMIT_KEY", "rate-limit enforcement is unavailable", traceId));
    }
    const admission = ctx.rateLimit({
      installationId: ctx.installationId,
      virtualKeyId: auth.key.id,
      estimatedTokens: estimateRateLimitTokens(decoded.body),
      ...auth.key.rateLimit,
    });
    if (!admission.allowed) {
      emitTerminal("RATE_LIMIT_KEY", { profileId, keyId: auth.key.id });
      const response = errorResponse("RATE_LIMIT_KEY", "rate limit exceeded", traceId);
      response.headers.set("retry-after", String(admission.retryAfterSeconds));
      return respond(response);
    }
  }

  const publicModel = decoded.publicModel;
  const route = legacyPathRoute
    ? resolveRoute(profileId, path, snapshot)
    : resolveRoute(profileId, decoded.endpointKind, publicModel!, snapshot);
  if (!route) {
    emitTerminal("ROUTE_UNKNOWN", { profileId, keyId: auth.key.id });
    return respond(errorResponse(
      "ROUTE_UNKNOWN",
      publicModel
        ? `no route for model '${publicModel}' on this endpoint`
        : `no route for '${path}' on this endpoint`,
      traceId,
    ));
  }
  telemetryRouteId = route.routeId;

  // 4. selectTarget — ordered/weighted → ROUTE_NO_HEALTHY_TARGET. Selected BEFORE enforcement so
  //    the hard-budget reserve can price its estimate against the ACTUAL dispatch target's offering
  //    (§6.10) — the reservation must reflect the provider the request will really hit.
  let target = selectTarget(route, ctx.rand);
  if (!target) {
    emitTerminal("ROUTE_NO_HEALTHY_TARGET", { profileId, keyId: auth.key.id, routeId: route.routeId });
    return respond(errorResponse("ROUTE_NO_HEALTHY_TARGET", "no healthy target for route", traceId));
  }

  // 4.5 ENFORCEMENT (SPEC §11 policy + §16.3 hard budget, review bug #9). After route + target
  //     resolution, BEFORE SSRF / dispatch: a denied model or an over-cap hard budget MUST NOT reach
  //     the provider. No-op (body untouched) when the profile carries no policy and the key has no
  //     hard budget. May consume the request body to read model/params + rewrite clamps.
  const enforcement = await enforceRequest({
    snapshot,
    profile,
    key: auth.key,
    request: decoded.request,
    traceId,
    target,
    reservationTargets: route.targets.filter(
      (candidate) => candidate.healthState !== "unhealthy",
    ),
    reserveBudget: ctx.reserveBudget,
  });
  if (!enforcement.ok) {
    emitTerminal(enforcement.code, { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId });
    return respond(errorResponse(enforcement.code, enforcement.message, traceId));
  }

  // A hard-budget reservation may now be HELD (enforcement.reservationId). Thread it onto EVERY
  // subsequent terminal — the success path AND the post-reserve failure paths (SSRF / credential /
  // dispatch error) — so the reconcile ALWAYS releases the hold (review gateway-F5/#2). Without this
  // the hold is orphaned until the (unwired) expiry sweep: a valid key that forces deterministic
  // post-reserve failures could accumulate holds to the cap and deny a tenant's real traffic.
  const reservationId = enforcement.reservationId ?? null;
  const reservationFallback = enforcement.reservationFallback;
  const budgetAccountId = auth.key.budgetAccountId;

  const method = decoded.request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const enforcedBody = enforcement.forwardBody !== undefined
    ? JSON.parse(enforcement.forwardBody) as Record<string, unknown>
    : undefined;
  const isCompositeRoute = !legacyPathRoute && Boolean(
    snapshot.routes[routeKey(profileId, decoded.endpointKind, publicModel!)],
  );
  const retryPolicy = retryPolicyFromSnapshot(route.retryPolicy);
  if (legacyPathRoute && enforcement.forwardBody === undefined && hasBody) retryPolicy.maxAttempts = 1;
  const orderedTargets = orderTargetAttempts(
    target,
    route.targets
      .filter((candidate) => candidate.healthState !== "unhealthy")
      .sort((left, right) => left.priority - right.priority),
  );
  const attempts = Array.from(
    { length: retryPolicy.maxAttempts },
    (_, index) => orderedTargets[index] ?? orderedTargets[index % orderedTargets.length]!,
  );
  const startedAtMs = Date.now();
  let upstream: Response | undefined;
  let lastFailure: { code: string; message: string } | undefined;

  // The request has passed authentication, routing, policy, and budget admission. Record that
  // durable trace root before any provider_attempt so retries/failovers reduce in causal order.
  emit({
    kind: "accepted",
    profileId,
    keyId: auth.key.id,
    routeId: route.routeId,
    offeringId: target.offeringId,
    status: null,
    reasonCodes: [],
    budgetAccountId,
  });

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    target = attempts[attemptIndex]!;
    // Current snapshots carry the durable DB target id. A legacy signed
    // snapshot remains dispatchable with a deterministic synthetic identity;
    // durable health admission will retain the telemetry and ignore that fact
    // because it cannot validate the synthetic id against gateway_target.
    const attemptTargetId = target.targetId ?? snapshotTargetIdentity(target);
    const upstreamUrl = upstreamUrlFor(target.baseUrl, url.pathname, url.search);
    const ssrf = ssrfCheck(upstreamUrl, target.allowedHosts, ctx.ssrfPolicy ?? STRICT_SSRF);
    if (!ssrf.ok) {
      lastFailure = { code: "SSRF_BLOCKED", message: `egress blocked: ${ssrf.reason}` };
      break;
    }

    const upstreamHeaders = headerAllowlist(decoded.request.headers);
    try {
      injectProviderAuth(upstreamHeaders, target.authInject, await ctx.resolveSecret(target));
    } catch {
      lastFailure = { code: "CREDENTIAL_UNAVAILABLE", message: "provider credential could not be resolved" };
      continue;
    }

    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: upstreamHeaders,
      signal: distributedGrantSignal
        ? AbortSignal.any([
          distributedGrantSignal,
          AbortSignal.timeout(Math.max(1, route.timeoutMs - (Date.now() - startedAtMs))),
        ])
        : AbortSignal.timeout(Math.max(1, route.timeoutMs - (Date.now() - startedAtMs))),
    };
    if (hasBody) {
      const offering = snapshot.offerings?.[target.offeringId];
      if (isCompositeRoute && !offering?.providerModelId) {
        lastFailure = { code: "ROUTE_NO_HEALTHY_TARGET", message: "selected target has no provider model mapping" };
        continue;
      }
      if (legacyPathRoute || !decoded.body) {
        init.body = enforcement.forwardBody ?? decoded.request.body;
      } else {
        const providerRequest = toOpenAiProviderRequest(
          decoded,
          { providerModelId: offering?.providerModelId ?? publicModel! },
          enforcedBody,
        );
        init.body = providerRequest.body;
      }
      init.duplex = "half";
    }

    const circuitInput = circuitTarget(ctx.installationId, target);
    const circuitAdmission = ctx.circuitBreaker?.allow(circuitInput);
    if (circuitAdmission && !circuitAdmission.allowed) {
      lastFailure = {
        code: "ROUTE_NO_HEALTHY_TARGET",
        message: "provider target circuit is open",
      };
      continue;
    }

    const attemptTelemetry = telemetryLifecycle.startAttempt({
      attempt: attemptIndex + 1,
      provider: target.offeringId,
      profileId,
      routeId: route.routeId,
      endpoint: telemetryEndpoint,
    });
    try {
      const candidate = await ctx.fetcher.fetch(new Request(upstreamUrl, init));
      const circuitFailure: CircuitFailure = { status: candidate.status };
      if (candidate.status >= 400) {
        ctx.circuitBreaker?.recordFailure(circuitInput, circuitFailure);
      } else {
        ctx.circuitBreaker?.recordSuccess(circuitInput);
      }
      const decision = decideRetry({
        completedAttempt: attemptIndex + 1,
        failure: { status: candidate.status },
        responseBytesReceived: 0,
        idempotencyKey: decoded.request.headers.get("idempotency-key"),
        retryAfter: candidate.headers.get("retry-after"),
        startedAtMs,
        deadlineMs: route.timeoutMs,
        policy: retryPolicy,
      });
      const willRetry = decision.retry && attemptIndex + 1 < attempts.length;
      const nextTarget = willRetry ? attempts[attemptIndex + 1] : undefined;
      const attemptReasons: ReasonCode[] = candidate.status >= 500
        ? ["PROVIDER_HTTP_5XX"]
        : candidate.status >= 400
          ? ["PROVIDER_HTTP_4XX"]
          : [];
      if (willRetry) {
        attemptReasons.push("RETRY_ATTEMPT");
        telemetryRetryCount += 1;
        if (
          nextTarget &&
          snapshotTargetIdentity(nextTarget) !== snapshotTargetIdentity(target)
        ) {
          attemptReasons.push("FAILOVER_ATTEMPT");
          telemetryFailoverCount += 1;
        }
      }
      attemptTelemetry.end({
        outcome: candidate.status >= 400 ? "error" : "success",
        statusCode: candidate.status,
        provider: target.offeringId,
        ...(candidate.status >= 400 ? { reason: "provider_error" } : {}),
        retried: willRetry,
        failedOver: attemptReasons.includes("FAILOVER_ATTEMPT"),
      });
      emit({
        kind: "provider_attempt",
        profileId,
        keyId: auth.key.id,
        routeId: route.routeId,
        offeringId: target.offeringId,
        status: candidate.status,
        reasonCodes: attemptReasons,
        targetId: attemptTargetId,
        routeRevisionId: route.revision,
        snapshotRevision: snapshot.meta.revision,
        attemptOutcome: attemptOutcomeForStatus(candidate.status),
      });
      if (willRetry) {
        await candidate.body?.cancel().catch(() => {});
        if (decision.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
        continue;
      }
      upstream = candidate;
      break;
    } catch (error) {
      const cause = (error as { cause?: { name?: string } }).cause;
      const isTimeout =
        (error instanceof DOMException && error.name === "TimeoutError") || cause?.name === "TimeoutError";
      const isEgressBlocked = error instanceof Error && error.message.startsWith("egress:");
      lastFailure = isEgressBlocked
        ? { code: "SSRF_BLOCKED", message: "egress blocked: destination not permitted" }
        : isTimeout
          ? { code: "PROVIDER_TIMEOUT", message: "upstream timed out" }
          : { code: "PROVIDER_HTTP_5XX", message: "upstream request failed" };
      ctx.circuitBreaker?.recordFailure(circuitInput, {
        timedOut: isTimeout,
        networkError: !isTimeout && !isEgressBlocked,
      });
      const decision = decideRetry({
        completedAttempt: attemptIndex + 1,
        failure: { timedOut: isTimeout, networkError: !isTimeout },
        responseBytesReceived: 0,
        idempotencyKey: decoded.request.headers.get("idempotency-key"),
        startedAtMs,
        deadlineMs: route.timeoutMs,
        policy: retryPolicy,
      });
      const willRetry = !isEgressBlocked && decision.retry && attemptIndex + 1 < attempts.length;
      const nextTarget = willRetry ? attempts[attemptIndex + 1] : undefined;
      const attemptReasons: ReasonCode[] = [lastFailure.code as ReasonCode];
      if (willRetry) {
        attemptReasons.push("RETRY_ATTEMPT");
        telemetryRetryCount += 1;
        if (
          nextTarget &&
          snapshotTargetIdentity(nextTarget) !== snapshotTargetIdentity(target)
        ) {
          attemptReasons.push("FAILOVER_ATTEMPT");
          telemetryFailoverCount += 1;
        }
      }
      attemptTelemetry.end({
        outcome: "error",
        provider: target.offeringId,
        ...(isTimeout ? { statusCode: 504, reason: "timeout" } : { reason: "network_error" }),
        retried: willRetry,
        failedOver: attemptReasons.includes("FAILOVER_ATTEMPT"),
      });
      emit({
        kind: "provider_attempt",
        profileId,
        keyId: auth.key.id,
        routeId: route.routeId,
        offeringId: target.offeringId,
        status: isTimeout ? 504 : null,
        reasonCodes: attemptReasons,
        targetId: attemptTargetId,
        routeRevisionId: route.revision,
        snapshotRevision: snapshot.meta.revision,
        attemptOutcome: "transient_failure",
      });
      if (!willRetry) break;
      if (decision.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
    }
  }

  if (!upstream) {
    const failure = lastFailure ?? { code: "PROVIDER_HTTP_5XX", message: "upstream request failed" };
    await emitTerminal(failure.code, { profileId, keyId: auth.key.id, routeId: route.routeId, offeringId: target.offeringId, reservationId, budgetAccountId });
    return respond(errorResponse(failure.code, failure.message, traceId));
  }

  if (upstream.status >= 400) {
    const reason: ReasonCode = upstream.status >= 500
      ? "PROVIDER_HTTP_5XX"
      : "PROVIDER_HTTP_4XX";
    const normalized = await normalizeProviderErrorResponse(upstream, traceId);
    const terminalDelivery = enqueue({
      kind: "terminal",
      profileId,
      keyId: auth.key.id,
      routeId: route.routeId,
      offeringId: target.offeringId,
      status: upstream.status,
      reasonCodes: [reason],
      budgetAccountId,
      ...(reservationId !== null ? { reservationId } : {}),
    });
    // A provider attempt has occurred, so its terminal trace must cross the
    // durable outbox boundary before the response can settle. This applies to
    // public traffic too; waitUntil accelerates the drain after the ledger row
    // exists and is never the durability boundary itself.
    await terminalDelivery;
    if (hasIngestFailure) throw ingestFailure;
    return respond(normalized);
  }

  // Dispatch-time price + provenance the terminal stamps for cost (§6.10): resolved from the
  // snapshot's offerings section for THIS offering, so cost uses the price in force when the
  // request ran (absent ⇒ no price → projected µ$0, unknown fidelity).
  const offering = snapshot.offerings?.[target.offeringId];
  const price = offering?.price;
  const priceRevisionId = offering?.priceRevisionId ?? null;

  // USAGE CAPTURE (§8.3): buffer only a small, self-described JSON completion. SSE is observed
  // through a bounded byte-transparent transform; other large/non-JSON bodies stay flat-memory.
  let responseBody: BodyInit | null = upstream.body;
  let usage: ObservationUsage | undefined;
  let capturedResponse: Record<string, unknown> | undefined;
  let streamingTerminal: Promise<void> | undefined;
  if (isBufferableJson(upstream)) {
    const bodyText = await upstream.text(); // bounded by content-length ≤ USAGE_CAPTURE_MAX_BYTES
    responseBody = bodyText; // re-emit the buffered bytes; the client sees the identical body
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      usage = parseUsageBlock(parsed);
      capturedResponse = objectCapture(parsed);
    } catch {
      usage = undefined; // unparseable JSON ⇒ no usage, still a clean passthrough
    }
  } else if (isInspectableJson(upstream) && upstream.body && upstream.headers.get("content-length") === null) {
    const captured = await captureUnknownLengthJson(upstream.body, USAGE_CAPTURE_MAX_BYTES);
    if (captured.captured) {
      // Copy into a concrete ArrayBuffer-backed view for the Fetch BodyInit contract while retaining
      // the provider's exact bytes (including malformed JSON that simply yields no usage).
      const replayBody = new Uint8Array(captured.body.byteLength);
      replayBody.set(captured.body);
      responseBody = replayBody;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(captured.body)) as unknown;
        usage = parseUsageBlock(parsed);
        capturedResponse = objectCapture(parsed);
      } catch {
        usage = undefined; // malformed JSON keeps its original bytes and simply has no usage
      }
    } else {
      responseBody = captured.body;
    }
  } else if (
    upstream.body &&
    (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
  ) {
    const observed = createSseUsageTransform({
      onFinalize: async (result) => {
        const streamUsage = result.usage ? parseUsageBlock({ usage: result.usage }) : undefined;
        const terminalUsage = streamUsage ?? reservationFallback?.usage;
        const aborted = result.aborted || !result.completed;
        telemetryStreamAborted = aborted;
        await enqueue({
          kind: "terminal",
          profileId,
          keyId: auth.key.id,
          routeId: route.routeId,
          offeringId: target.offeringId,
          status: aborted ? 502 : upstream.status,
          reasonCodes: aborted ? ["PROVIDER_STREAM_ABORTED"] : [],
          ...(terminalUsage ? { usage: terminalUsage } : {}),
          ...(terminalUsage && price ? { price } : {}),
          ...(terminalUsage ? { priceRevisionId } : {}),
          ...(!streamUsage && reservationFallback ? { costFidelity: "estimated" as const } : {}),
          budgetAccountId,
          ...(reservationId !== null ? { reservationId } : {}),
        });
        if (reservationId !== null && hasIngestFailure) throw ingestFailure;
      },
    });
    responseBody = relayObservedStream(upstream.body, observed);
    streamingTerminal = observed.result.then(() => undefined);
  }

  // Terminal event for the success path. Observability's reduce() treats a trace with no terminal
  // as incomplete (→ $0 cost), so EVERY request — including a 200 dispatch — MUST end with a
  // terminal (§8.3). When usage was captured it carries the token counts + dispatch price +
  // price-revision + reservation, so the projection writes a real cost_ledger row and reconciles
  // the hold reserved→committed (§6.9/§8.4).
  const capture = boundedObservationCapture((route as typeof route & { capturePolicy?: SnapshotCapturePolicy }).capturePolicy, objectCapture(decoded.body), capturedResponse);
  const terminalDelivery = streamingTerminal ?? enqueue({
    kind: "terminal",
    profileId,
    keyId: auth.key.id,
    routeId: route.routeId,
    offeringId: target.offeringId,
    status: upstream.status,
    reasonCodes: [],
    ...(usage ? { usage } : reservationFallback ? { usage: reservationFallback.usage } : {}),
    ...(usage && price ? { price } : reservationFallback && price ? { price } : {}),
    ...(usage ? { priceRevisionId } : reservationFallback ? { priceRevisionId } : {}),
    ...(!usage && reservationFallback ? { costFidelity: "estimated" as const } : {}),
    budgetAccountId,
    ...(capture ? { capture } : {}),
    ...(reservationId !== null ? { reservationId } : {}),
  });

  if (streamingTerminal === undefined) {
    // Every completed provider request durably hands off its terminal trace
    // before exposing the response. A held reservation additionally requires
    // the same boundary for billing reconciliation.
    await terminalDelivery;
    if (hasIngestFailure) throw ingestFailure;
  } else {
    // Streaming reconciliation completes when the transformed body reaches [DONE]. The durable
    // Vercel sink synchronously enqueues that terminal intent; non-streaming hard-budget traffic
    // still waits above before exposing the provider response.
    void terminalDelivery.catch(() => {});
  }

  const responseHeaders = sanitizeResponseHeaders(upstream.headers);
  responseHeaders.set("x-trace-id", traceId);
  return respond(new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  }));
  } catch (error) {
    await releaseAdmission().catch(() => {});
    endTelemetry(500, "error");
    throw error;
  }
}
