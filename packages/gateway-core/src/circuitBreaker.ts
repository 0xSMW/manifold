/**
 * A bounded, per-isolate provider circuit breaker. It is deliberately a local
 * fast-fail signal: callers that need fleet-wide health must additionally use
 * durable provider-attempt telemetry and a distributed health authority.
 */

/** A monotonic millisecond clock; `performance.now()` is used by default. */
export interface CircuitBreakerClock {
  now(): number;
}

export interface CircuitBreakerOptions {
  /** Consecutive transient failures in the rolling window needed to open. Default: 5. */
  failureThreshold?: number;
  /** Failures older than this are discarded. Default: one minute. */
  rollingWindowMs?: number;
  /** Time an open circuit remains unavailable before one probe is permitted. Default: 30 seconds. */
  resetTimeoutMs?: number;
  /** Delay advertised while the sole half-open probe is in flight. Default: one second. */
  halfOpenProbeRetryAfterMs?: number;
  /** Maximum retained installation/target states. Default: 10,000. */
  maxEntries?: number;
  /** Evict inactive state after this duration. Default: 15 minutes. */
  idleTtlMs?: number;
  clock?: CircuitBreakerClock;
}

/** Stable, non-secret provider target identity scoped to one installation. */
export interface CircuitTargetInput {
  installationId: string;
  targetId: string;
}

/** Failure facts supplied by the egress layer after an attempted provider call. */
export interface CircuitFailure {
  status?: number;
  timedOut?: boolean;
  networkError?: boolean;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitDecision {
  allowed: boolean;
  state: CircuitState;
  /** True only for the sole request admitted to probe a half-open circuit. */
  probe: boolean;
  /** Delay before retrying this target on this isolate. */
  retryAfterMs: number;
  /** HTTP Retry-After value, rounded up to seconds. */
  retryAfterSeconds: number;
}

export interface CircuitStateSnapshot {
  installationId: string;
  targetId: string;
  state: CircuitState;
  failuresInWindow: number;
  probeInFlight: boolean;
  retryAfterMs: number;
  lastAccessMs: number;
}

export interface CircuitBreakerSnapshot {
  capturedAtMs: number;
  total: number;
  closed: number;
  open: number;
  halfOpen: number;
  entries: CircuitStateSnapshot[];
}

interface Entry {
  installationId: string;
  targetId: string;
  state: CircuitState;
  failures: number[];
  openedAtMs?: number;
  probeInFlight: boolean;
  lastAccessMs: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_ROLLING_WINDOW_MS = 60_000;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;
const DEFAULT_HALF_OPEN_PROBE_RETRY_AFTER_MS = 1_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;

function defaultClock(): CircuitBreakerClock {
  return { now: () => performance.now() };
}

function positiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`);
}

function positiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
}

function identity(input: CircuitTargetInput): string {
  if (input.installationId.length === 0 || input.targetId.length === 0) {
    throw new TypeError("installationId and targetId must be non-empty");
  }
  return `${input.installationId}\u0000${input.targetId}`;
}

/** True only for faults that represent provider availability, not caller mistakes. */
export function isTransientCircuitFailure(failure: CircuitFailure): boolean {
  if (failure.timedOut || failure.networkError) return true;
  const status = failure.status;
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

/**
 * Map insertion order is the LRU queue. The state is scoped by installation so
 * one tenant's target health can never suppress another tenant's traffic.
 */
export class LocalCircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly failureThreshold: number;
  private readonly rollingWindowMs: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenProbeRetryAfterMs: number;
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private readonly clock: CircuitBreakerClock;
  private lastObservedMs = Number.NEGATIVE_INFINITY;

  constructor(options: CircuitBreakerOptions = {}) {
    const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    const rollingWindowMs = options.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS;
    const resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    const halfOpenProbeRetryAfterMs = options.halfOpenProbeRetryAfterMs ?? DEFAULT_HALF_OPEN_PROBE_RETRY_AFTER_MS;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    positiveSafeInteger("failureThreshold", failureThreshold);
    positiveFinite("rollingWindowMs", rollingWindowMs);
    positiveFinite("resetTimeoutMs", resetTimeoutMs);
    positiveFinite("halfOpenProbeRetryAfterMs", halfOpenProbeRetryAfterMs);
    positiveSafeInteger("maxEntries", maxEntries);
    positiveFinite("idleTtlMs", idleTtlMs);
    this.failureThreshold = failureThreshold;
    this.rollingWindowMs = rollingWindowMs;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenProbeRetryAfterMs = halfOpenProbeRetryAfterMs;
    this.maxEntries = maxEntries;
    this.idleTtlMs = idleTtlMs;
    this.clock = options.clock ?? defaultClock();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Checks admission. Call `recordSuccess` or `recordFailure` exactly once for each allowed attempt. */
  allow(input: CircuitTargetInput): CircuitDecision {
    const now = this.now();
    this.expireIdle(now);
    const entry = this.entry(input, now);
    this.trimFailures(entry, now);

    if (entry.state === "open") {
      const remaining = this.openRemaining(entry, now);
      if (remaining > 0) return this.denied("open", remaining);
      entry.state = "half_open";
      entry.probeInFlight = false;
      entry.openedAtMs = undefined;
    }
    if (entry.state === "half_open") {
      if (entry.probeInFlight) return this.denied("half_open", this.halfOpenProbeRetryAfterMs);
      entry.probeInFlight = true;
      return { allowed: true, state: "half_open", probe: true, retryAfterMs: 0, retryAfterSeconds: 0 };
    }
    return { allowed: true, state: "closed", probe: false, retryAfterMs: 0, retryAfterSeconds: 0 };
  }

  /** A provider success restores a half-open circuit and clears stale failures. */
  recordSuccess(input: CircuitTargetInput): void {
    const now = this.now();
    this.expireIdle(now);
    const entry = this.entry(input, now);
    entry.state = "closed";
    entry.failures = [];
    entry.openedAtMs = undefined;
    entry.probeInFlight = false;
  }

  /**
   * Records only transient provider availability failures. A non-transient 4xx
   * proves the provider answered, so it restores a pending half-open probe and
   * cannot poison health with invalid caller traffic.
   */
  recordFailure(input: CircuitTargetInput, failure: CircuitFailure): CircuitState {
    const now = this.now();
    this.expireIdle(now);
    const entry = this.entry(input, now);
    if (!isTransientCircuitFailure(failure)) {
      entry.state = "closed";
      entry.failures = [];
      entry.openedAtMs = undefined;
      entry.probeInFlight = false;
      return entry.state;
    }

    if (entry.state === "half_open") {
      this.open(entry, now);
      return entry.state;
    }
    if (entry.state === "open") return entry.state;

    this.trimFailures(entry, now);
    entry.failures.push(now);
    if (entry.failures.length >= this.failureThreshold) this.open(entry, now);
    return entry.state;
  }

  /** Safe, bounded state suitable for health metrics; target IDs must be non-secret identifiers. */
  snapshot(): CircuitBreakerSnapshot {
    const now = this.now();
    this.expireIdle(now);
    let closed = 0;
    let open = 0;
    let halfOpen = 0;
    const entries = [...this.entries.values()].map((entry) => {
      this.trimFailures(entry, now);
      const state = entry.state;
      if (state === "closed") closed += 1;
      else if (state === "open") open += 1;
      else halfOpen += 1;
      return {
        installationId: entry.installationId,
        targetId: entry.targetId,
        state,
        failuresInWindow: entry.failures.length,
        probeInFlight: entry.probeInFlight,
        retryAfterMs: state === "open" ? this.openRemaining(entry, now) : state === "half_open" && entry.probeInFlight ? this.halfOpenProbeRetryAfterMs : 0,
        lastAccessMs: entry.lastAccessMs,
      };
    });
    return { capturedAtMs: now, total: entries.length, closed, open, halfOpen, entries };
  }

  private now(): number {
    const observed = this.clock.now();
    if (!Number.isFinite(observed)) throw new TypeError("clock returned a non-finite value");
    // Tests and platform clocks may regress; no regression may shorten an open
    // duration, refill a rolling window, or revive an evicted entry.
    this.lastObservedMs = Math.max(this.lastObservedMs, observed);
    return this.lastObservedMs;
  }

  private entry(input: CircuitTargetInput, now: number): Entry {
    const key = identity(input);
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      entry.lastAccessMs = now;
      return entry;
    }
    this.evictToMakeRoom();
    entry = {
      installationId: input.installationId,
      targetId: input.targetId,
      state: "closed",
      failures: [],
      probeInFlight: false,
      lastAccessMs: now,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private open(entry: Entry, now: number): void {
    entry.state = "open";
    entry.openedAtMs = now;
    entry.probeInFlight = false;
  }

  private openRemaining(entry: Entry, now: number): number {
    const openedAtMs = entry.openedAtMs ?? now;
    return Math.max(0, Math.ceil(openedAtMs + this.resetTimeoutMs - now));
  }

  private denied(state: Extract<CircuitState, "open" | "half_open">, retryAfterMs: number): CircuitDecision {
    return {
      allowed: false,
      state,
      probe: false,
      retryAfterMs,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
    };
  }

  private trimFailures(entry: Entry, now: number): void {
    const cutoff = now - this.rollingWindowMs;
    while (entry.failures.length > 0 && entry.failures[0]! <= cutoff) entry.failures.shift();
  }

  private expireIdle(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessMs >= this.idleTtlMs) this.entries.delete(key);
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
