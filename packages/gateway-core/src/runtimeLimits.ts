/**
 * Small, per-isolate admission controls for the gateway runtime. They are
 * deliberately local and bounded: a distributed quota/concurrency authority
 * remains necessary when a fleet-wide limit is required.
 */

export interface RuntimeLimitClock {
  now(): number;
}

export interface RequestBodyLimitOptions {
  /** Maximum accepted request body size in bytes. */
  maxBytes: number;
}

export interface AcceptedRequestBody {
  allowed: true;
  bytes: number;
  /** A fresh request whose body can be read by the provider dispatch path. */
  request: Request;
}

export interface RejectedRequestBody {
  allowed: false;
  status: 413;
  code: "REQUEST_BODY_TOO_LARGE";
  limitBytes: number;
  observedBytes: number;
}

export type RequestBodyLimitDecision = AcceptedRequestBody | RejectedRequestBody;

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) return undefined;
  // Multiple/comma-separated values are invalid framing. Leave those to the
  // upstream HTTP implementation; they cannot safely be used as a fast path.
  if (!/^(?:0|[1-9][0-9]*)$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function replayRequest(source: Request, bytes?: Uint8Array): Request {
  const method = source.method.toUpperCase();
  // bytes is allocated by this module, so its backing store is an ArrayBuffer
  // (not a SharedArrayBuffer). DOM's generic typed-array declaration cannot
  // infer that narrower runtime fact.
  const body = bytes && method !== "GET" && method !== "HEAD" ? (bytes.buffer as ArrayBuffer) : undefined;
  return new Request(source.url, {
    method: source.method,
    headers: new Headers(source.headers),
    body,
    signal: source.signal,
  });
}

/**
 * Reads an inbound request at most once, buffering no more than maxBytes.
 * Accepted bodies are reconstructed as a new, replayable Web Request. A
 * declared oversized Content-Length is rejected before its stream is touched;
 * a chunked overflow cancels the source reader promptly.
 */
export async function limitRequestBody(
  request: Request,
  options: RequestBodyLimitOptions,
): Promise<RequestBodyLimitDecision> {
  assertPositiveSafeInteger("maxBytes", options.maxBytes);
  const declaredLength = contentLength(request.headers);
  if (declaredLength !== undefined && declaredLength > options.maxBytes) {
    return {
      allowed: false,
      status: 413,
      code: "REQUEST_BODY_TOO_LARGE",
      limitBytes: options.maxBytes,
      observedBytes: declaredLength,
    };
  }

  if (request.body === null) {
    return { allowed: true, bytes: 0, request: replayRequest(request) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      // Check before retaining the chunk so the retained body is bounded even
      // when an upstream sends a single enormous chunk.
      if (chunk.byteLength > options.maxBytes - total) {
        await reader.cancel("request body exceeds configured limit").catch(() => undefined);
        return {
          allowed: false,
          status: 413,
          code: "REQUEST_BODY_TOO_LARGE",
          limitBytes: options.maxBytes,
          observedBytes: total + chunk.byteLength,
        };
      }
      chunks.push(chunk);
      total += chunk.byteLength;
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
  return { allowed: true, bytes: total, request: replayRequest(request, bytes) };
}

export interface LocalConcurrencyLimiterOptions {
  /** Maximum in-flight requests per installation/key pair. */
  perKeyCap: number;
  /** Maximum in-flight requests retained by this isolate. */
  globalCap: number;
  /** Bound cached idle key state. Defaults to 10,000. */
  maxEntries?: number;
  /** Idle, inactive entries expire after this duration. Defaults to 15 minutes. */
  idleTtlMs?: number;
  clock?: RuntimeLimitClock;
}

export interface ConcurrencyInput {
  installationId: string;
  /** Stable virtual-key ID. Do not pass the presented credential. */
  virtualKeyId: string;
}

export type ConcurrencyDenyReason = "global_concurrency" | "key_concurrency" | "registry_capacity";

export interface ConcurrencyDenied {
  allowed: false;
  status: 429;
  code: "CONCURRENCY_LIMIT";
  reason: ConcurrencyDenyReason;
  /** A conservative retry hint; a release may make capacity available sooner. */
  retryAfterMs: number;
  retryAfterSeconds: number;
  globalInFlight: number;
  keyInFlight: number;
}

export interface ConcurrencyGranted {
  allowed: true;
  globalInFlight: number;
  keyInFlight: number;
  /** Idempotent; callers should invoke it in a finally block. */
  release(): void;
}

export type ConcurrencyDecision = ConcurrencyDenied | ConcurrencyGranted;

interface ConcurrencyState {
  inFlight: number;
  lastAccessMs: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;
const RETRY_AFTER_MS = 1_000;

function defaultClock(): RuntimeLimitClock {
  return { now: () => performance.now() };
}

function stateKey(input: ConcurrencyInput): string {
  if (input.installationId.length === 0 || input.virtualKeyId.length === 0) {
    throw new TypeError("installationId and virtualKeyId must be non-empty");
  }
  return `${input.installationId}\u0000${input.virtualKeyId}`;
}

/**
 * Bounded local concurrency guard. Active keys are never evicted, so a grant's
 * release closure always addresses retained state. When every retained key is
 * active, a new key is denied rather than growing memory without a bound.
 */
export class LocalConcurrencyLimiter {
  private readonly entries = new Map<string, ConcurrencyState>();
  private readonly perKeyCap: number;
  private readonly globalCap: number;
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private readonly clock: RuntimeLimitClock;
  private globalInFlight = 0;

  constructor(options: LocalConcurrencyLimiterOptions) {
    assertPositiveSafeInteger("perKeyCap", options.perKeyCap);
    assertPositiveSafeInteger("globalCap", options.globalCap);
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    assertPositiveSafeInteger("maxEntries", maxEntries);
    if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) throw new TypeError("idleTtlMs must be positive and finite");
    this.perKeyCap = options.perKeyCap;
    this.globalCap = options.globalCap;
    this.maxEntries = maxEntries;
    this.idleTtlMs = idleTtlMs;
    this.clock = options.clock ?? defaultClock();
  }

  get size(): number {
    return this.entries.size;
  }

  get inFlight(): number {
    return this.globalInFlight;
  }

  acquire(input: ConcurrencyInput): ConcurrencyDecision {
    const key = stateKey(input);
    const now = this.clock.now();
    if (!Number.isFinite(now)) throw new TypeError("clock returned a non-finite value");
    this.expireIdle(now);
    let state = this.entries.get(key);
    if (state) {
      this.entries.delete(key);
      this.entries.set(key, state);
      state.lastAccessMs = Math.max(state.lastAccessMs, now);
    } else {
      if (!this.makeRoom()) return this.denied("registry_capacity", 0);
      state = { inFlight: 0, lastAccessMs: now };
      this.entries.set(key, state);
    }

    if (this.globalInFlight >= this.globalCap) return this.denied("global_concurrency", state.inFlight);
    if (state.inFlight >= this.perKeyCap) return this.denied("key_concurrency", state.inFlight);

    state.inFlight += 1;
    this.globalInFlight += 1;
    let released = false;
    return {
      allowed: true,
      globalInFlight: this.globalInFlight,
      keyInFlight: state.inFlight,
      release: () => {
        if (released) return;
        released = true;
        // State cannot be evicted while inFlight is positive. Keep the guard in
        // case a future internal refactor changes that invariant.
        const current = this.entries.get(key);
        if (!current || current.inFlight < 1 || this.globalInFlight < 1) return;
        current.inFlight -= 1;
        current.lastAccessMs = Math.max(current.lastAccessMs, this.clock.now());
        this.globalInFlight -= 1;
      },
    };
  }

  private denied(reason: ConcurrencyDenyReason, keyInFlight: number): ConcurrencyDenied {
    return {
      allowed: false,
      status: 429,
      code: "CONCURRENCY_LIMIT",
      reason,
      retryAfterMs: RETRY_AFTER_MS,
      retryAfterSeconds: 1,
      globalInFlight: this.globalInFlight,
      keyInFlight,
    };
  }

  private expireIdle(now: number): void {
    for (const [key, state] of this.entries) {
      if (state.inFlight === 0 && now >= state.lastAccessMs && now - state.lastAccessMs >= this.idleTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  private makeRoom(): boolean {
    while (this.entries.size >= this.maxEntries) {
      let evicted = false;
      for (const [key, state] of this.entries) {
        if (state.inFlight === 0) {
          this.entries.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) return false;
    }
    return true;
  }
}
