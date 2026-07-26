/**
 * Per-isolate admission control for a Fluid function. This intentionally has no
 * storage or network dependency: it is a fast local guard in front of the
 * distributed limiter, not an authority for a fleet-wide quota.
 *
 * A key can burst up to configured `burst` requests (default `rpm`) and `tpm`
 * estimated tokens per isolate.
 * With N simultaneously warm isolates, aggregate admission can therefore burst
 * up to N times either configured capacity (an overshoot of (N - 1) capacities
 * compared with one global bucket). Callers needing a strict global quota must
 * layer a distributed limiter after this guard.
 */

/** A monotonic millisecond clock. `performance.now()` is used by default. */
export interface MonotonicClock {
  now(): number;
}

export interface LocalRateLimiterOptions {
  /** Maximum requests admitted per minute for one installation/key pair. */
  rpm: number;
  /** Request-token bucket capacity. Defaults to rpm. */
  burst?: number;
  /** Maximum estimated tokens admitted per minute for one installation/key pair. */
  tpm: number;
  /** Hard upper bound for cached key state. Defaults to 10,000. */
  maxEntries?: number;
  /** Inactive entries expire after this many milliseconds. Defaults to 15 minutes. */
  idleTtlMs?: number;
  /** Inject a monotonic clock for deterministic tests and platform adaptation. */
  clock?: MonotonicClock;
}

export interface RateLimitInput {
  installationId: string;
  /** Stable virtual-key identifier. Never pass a presented secret here. */
  virtualKeyId: string;
  /** Conservatively estimated input plus requested output tokens. */
  estimatedTokens: number;
}

export type RateLimitReason = "rpm" | "tpm" | "rpm_and_tpm";

export interface RateLimitDecision {
  allowed: boolean;
  reason?: RateLimitReason;
  /** Delay before the same request is likely to be admitted by this isolate. */
  retryAfterMs: number;
  /** HTTP Retry-After value, rounded up to whole seconds. */
  retryAfterSeconds: number;
  remainingRequests: number;
  remainingTokens: number;
}

interface BucketState {
  requestTokens: number;
  tokenTokens: number;
  lastRefillMs: number;
  lastAccessMs: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;

function defaultClock(): MonotonicClock {
  return { now: () => performance.now() };
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function keyFor(installationId: string, virtualKeyId: string): string {
  if (installationId.length === 0 || virtualKeyId.length === 0) {
    throw new TypeError("installationId and virtualKeyId must be non-empty");
  }
  // NUL cannot collide with a pair of strings joined by the same separator.
  return `${installationId}\u0000${virtualKeyId}`;
}

/**
 * Bounded, LRU-evicted dual token bucket. Map insertion order is its LRU list:
 * a consumed entry is moved to the tail and the oldest entry is evicted first.
 */
export class LocalRateLimiter {
  private readonly entries = new Map<string, BucketState>();
  private readonly rpm: number;
  private readonly burst: number;
  private readonly tpm: number;
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private readonly clock: MonotonicClock;

  constructor(options: LocalRateLimiterOptions) {
    assertPositiveFinite("rpm", options.rpm);
    assertPositiveFinite("tpm", options.tpm);
    const burst = options.burst ?? options.rpm;
    assertPositiveFinite("burst", burst);
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive safe integer");
    }
    assertPositiveFinite("idleTtlMs", idleTtlMs);

    this.rpm = options.rpm;
    this.burst = burst;
    this.tpm = options.tpm;
    this.maxEntries = maxEntries;
    this.idleTtlMs = idleTtlMs;
    this.clock = options.clock ?? defaultClock();
  }

  /** Current retained state count, exposed for health metrics and tests. */
  get size(): number {
    return this.entries.size;
  }

  consume(input: RateLimitInput): RateLimitDecision {
    if (!Number.isFinite(input.estimatedTokens) || input.estimatedTokens < 0) {
      throw new TypeError("estimatedTokens must be a non-negative finite number");
    }
    const estimatedTokens = Math.ceil(input.estimatedTokens);
    const key = keyFor(input.installationId, input.virtualKeyId);
    const observedNow = this.clock.now();
    if (!Number.isFinite(observedNow)) throw new TypeError("clock returned a non-finite value");

    this.expireIdle(observedNow);
    let state = this.entries.get(key);
    if (state) {
      // Move to the LRU tail before inspecting it. A rejected request is still
      // active traffic and must not lose its state ahead of an idle entry.
      this.entries.delete(key);
      this.entries.set(key, state);
      this.refill(state, observedNow);
    } else {
      this.evictToMakeRoom();
      state = {
        requestTokens: this.burst,
        tokenTokens: this.tpm,
        lastRefillMs: observedNow,
        lastAccessMs: observedNow,
      };
      this.entries.set(key, state);
    }
    state.lastAccessMs = Math.max(state.lastAccessMs, observedNow);

    const requestAllowed = state.requestTokens >= 1;
    const tokenAllowed = state.tokenTokens >= estimatedTokens;
    if (requestAllowed && tokenAllowed) {
      state.requestTokens -= 1;
      state.tokenTokens -= estimatedTokens;
      return this.decision(true, state, 0);
    }

    const retryAfterMs = this.retryAfterMs(state, estimatedTokens, requestAllowed, tokenAllowed);
    const reason: RateLimitReason = requestAllowed ? "tpm" : tokenAllowed ? "rpm" : "rpm_and_tpm";
    return { ...this.decision(false, state, retryAfterMs), reason };
  }

  private refill(state: BucketState, observedNow: number): void {
    // A regressing injected clock never refills or rewinds the bucket.
    const now = Math.max(observedNow, state.lastRefillMs);
    const elapsedMs = now - state.lastRefillMs;
    if (elapsedMs > 0) {
      state.requestTokens = Math.min(this.burst, state.requestTokens + (elapsedMs * this.rpm) / 60_000);
      state.tokenTokens = Math.min(this.tpm, state.tokenTokens + (elapsedMs * this.tpm) / 60_000);
      state.lastRefillMs = now;
    }
  }

  private retryAfterMs(
    state: BucketState,
    estimatedTokens: number,
    requestAllowed: boolean,
    tokenAllowed: boolean,
  ): number {
    const requestDelay = requestAllowed ? 0 : ((1 - state.requestTokens) * 60_000) / this.rpm;
    // A single request greater than a full bucket cannot be admitted until the
    // caller lowers its estimate. Return one complete window rather than 0.
    const tokenDelay = tokenAllowed
      ? 0
      : estimatedTokens > this.tpm
        ? 60_000
        : ((estimatedTokens - state.tokenTokens) * 60_000) / this.tpm;
    return Math.max(1, Math.ceil(Math.max(requestDelay, tokenDelay)));
  }

  private decision(allowed: boolean, state: BucketState, retryAfterMs: number): Omit<RateLimitDecision, "reason"> {
    return {
      allowed,
      retryAfterMs,
      retryAfterSeconds: retryAfterMs === 0 ? 0 : Math.ceil(retryAfterMs / 1_000),
      remainingRequests: Math.max(0, Math.floor(state.requestTokens)),
      remainingTokens: Math.max(0, Math.floor(state.tokenTokens)),
    };
  }

  private expireIdle(observedNow: number): void {
    for (const [key, state] of this.entries) {
      // Do not expire active state because a test clock moved backward.
      if (observedNow >= state.lastAccessMs && observedNow - state.lastAccessMs >= this.idleTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictToMakeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
