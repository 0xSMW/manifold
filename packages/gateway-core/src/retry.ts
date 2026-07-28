import type { Crypto, SnapshotTarget } from "@manifold/ports";

/**
 * Retry limits deliberately stay small: an upstream POST is only replayed when
 * it is known to be safe, and every wait consumes the route's total deadline.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxRetryAfterMs: number;
  retryOn: readonly RetryCondition[];
}

export type RetryPolicyInput = Partial<RetryPolicy>;
export type RetryCondition = "408" | "409" | "429" | "5xx" | "timeout" | "network";

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 2_000,
  maxRetryAfterMs: 30_000,
  retryOn: ["408", "409", "429", "5xx", "timeout", "network"] as const,
});

const MAX_ATTEMPTS_CAP = 5;
const MAX_BACKOFF_CAP_MS = 30_000;
const MAX_RETRY_AFTER_CAP_MS = 60_000;

function finiteInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

/** Normalizes untrusted configuration to bounded values suitable for a Fluid invocation. */
export function normalizeRetryPolicy(input: RetryPolicyInput = {}): RetryPolicy {
  const maxAttempts = finiteInteger(input.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts, 1, MAX_ATTEMPTS_CAP);
  const baseBackoffMs = finiteInteger(input.baseBackoffMs, DEFAULT_RETRY_POLICY.baseBackoffMs, 0, MAX_BACKOFF_CAP_MS);
  const maxBackoffMs = finiteInteger(
    input.maxBackoffMs,
    DEFAULT_RETRY_POLICY.maxBackoffMs,
    baseBackoffMs,
    MAX_BACKOFF_CAP_MS,
  );
  const maxRetryAfterMs = finiteInteger(
    input.maxRetryAfterMs,
    DEFAULT_RETRY_POLICY.maxRetryAfterMs,
    0,
    MAX_RETRY_AFTER_CAP_MS,
  );
  const retryOn = input.retryOn === undefined
    ? DEFAULT_RETRY_POLICY.retryOn
    : [...new Set(input.retryOn.filter(isRetryCondition))];
  return { maxAttempts, baseBackoffMs, maxBackoffMs, maxRetryAfterMs, retryOn };
}

function isRetryCondition(value: unknown): value is RetryCondition {
  return value === "408" ||
    value === "409" ||
    value === "429" ||
    value === "5xx" ||
    value === "timeout" ||
    value === "network";
}

/** Accept the persisted snake_case route-policy vocabulary without leaking it through the runtime API. */
export function retryPolicyFromSnapshot(input: Record<string, unknown> | undefined): RetryPolicy {
  const number = (camel: string, snake: string): number | undefined => {
    const value = input?.[camel] ?? input?.[snake];
    return typeof value === "number" ? value : undefined;
  };
  const backoff = number("baseBackoffMs", "backoff_ms");
  const retryOnValue = input?.retryOn ?? input?.retry_on;
  const retryOn = Array.isArray(retryOnValue)
    ? retryOnValue.filter(isRetryCondition)
    : undefined;
  return normalizeRetryPolicy({
    maxAttempts: number("maxAttempts", "max_attempts"),
    baseBackoffMs: backoff,
    maxBackoffMs: number("maxBackoffMs", "max_backoff_ms") ?? backoff,
    maxRetryAfterMs: number("maxRetryAfterMs", "max_retry_after_ms"),
    ...(retryOn ? { retryOn } : {}),
  });
}

/** Parses HTTP Retry-After delta-seconds or HTTP-date. Invalid values are ignored. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // Retry-After permits only an integer number of seconds. Do not accept a
  // fractional value here, because coercing it can unexpectedly shorten a ban.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }

  // Date.parse intentionally accepts browser-specific shorthand such as "1.5".
  // Require a weekday-prefixed HTTP-date before handing it to the platform parser.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:,|\s)/.test(trimmed)) return undefined;
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

/** Backoff for a completed attempt (one-based), bounded even for a malicious Retry-After. */
export function retryDelayMs(
  completedAttempt: number,
  policy: RetryPolicyInput = {},
  retryAfter: string | null | undefined = undefined,
  nowMs = Date.now(),
): number {
  const normalized = normalizeRetryPolicy(policy);
  const exponent = Math.max(0, Math.floor(completedAttempt) - 1);
  const exponential = Math.min(normalized.maxBackoffMs, normalized.baseBackoffMs * 2 ** exponent);
  const parsedRetryAfter = parseRetryAfterMs(retryAfter, nowMs);
  const serverDelay = parsedRetryAfter === undefined
    ? 0
    : Math.min(normalized.maxRetryAfterMs, parsedRetryAfter);
  return Math.min(normalized.maxBackoffMs, Math.max(exponential, serverDelay));
}

export interface RetryableFailure {
  status?: number;
  /** The dispatch layer sets this for AbortSignal/timeout failures. */
  timedOut?: boolean;
  /** The dispatch layer sets this for failures before an HTTP response exists. */
  networkError?: boolean;
}

/**
 * A provider idempotency contract is deliberately bound to one persisted target.
 * Provider idempotency stores are not shared between credentials/providers, so a
 * client key may only authorize a replay to this exact target.
 */
export interface ProviderIdempotencyContract {
  targetId: string;
  headerName: "idempotency-key";
}

const MAX_INBOUND_IDEMPOTENCY_KEY_CHARS = 1_024;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * Derive the provider-facing idempotency value from the only three identities
 * that may authorize a billable replay. The client value is deliberately never
 * forwarded or recorded: the fixed-size HMAC output is safe for provider
 * headers and remains distinct for every installation/target pair.
 */
export async function deriveProviderIdempotencyKey(
  crypto: Crypto,
  pepper: Uint8Array,
  installationId: string,
  targetId: string,
  clientKey: string | null | undefined,
): Promise<string | undefined> {
  if (
    !installationId ||
    !targetId ||
    typeof clientKey !== "string" ||
    clientKey.trim().length === 0 ||
    clientKey.length > MAX_INBOUND_IDEMPOTENCY_KEY_CHARS
  ) return undefined;
  const message = new TextEncoder().encode(JSON.stringify([
    "manifold-provider-idempotency-v1",
    installationId,
    targetId,
    clientKey,
  ]));
  const digest = await crypto.hmacSha256(pepper, message);
  return `mf_${base64Url(digest)}`;
}

/**
 * Read the only replay contract understood by the gateway from signed route
 * policy. Unknown/malformed policy is not a contract. The persisted wire shape
 * is deliberately canonical and closed: `target_id` + `header_name` only.
 */
export function providerIdempotencyContractFromSnapshot(
  input: Record<string, unknown> | undefined,
): ProviderIdempotencyContract | undefined {
  const raw = input?.provider_idempotency;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "header_name" || keys[1] !== "target_id") return undefined;
  const targetId = record.target_id;
  const headerName = record.header_name;
  if (typeof targetId !== "string" || targetId.trim().length === 0) return undefined;
  if (headerName !== "idempotency-key") return undefined;
  return { targetId, headerName: "idempotency-key" };
}

/** Retry only transient provider responses and explicit timeout/network failures. */
export function isRetryableFailure(
  failure: RetryableFailure,
  retryOn: readonly RetryCondition[] = DEFAULT_RETRY_POLICY.retryOn,
): boolean {
  if (failure.timedOut) return retryOn.includes("timeout");
  if (failure.networkError) return retryOn.includes("network");
  const status = failure.status;
  return (status === 408 && retryOn.includes("408")) ||
    (status === 409 && retryOn.includes("409")) ||
    (status === 429 && retryOn.includes("429")) ||
    (status !== undefined && status >= 500 && status <= 599 && retryOn.includes("5xx"));
}

/**
 * A billable POST is replayable only when the signed route explicitly binds a
 * provider idempotency contract to this target and the client supplied a key.
 * Response-byte counts cannot establish whether the provider accepted/billed a
 * request, so zero bytes is intentionally not treated as safe.
 */
export function isSafePostRetry(
  _responseBytesReceived: number,
  idempotencyKey?: string | null,
  contract?: ProviderIdempotencyContract,
): boolean {
  return contract !== undefined && typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0;
}

/** Remaining route-level time, never negative. */
export function remainingDeadlineMs(startedAtMs: number, deadlineMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return 0;
  return Math.max(0, deadlineMs - Math.max(0, nowMs - startedAtMs));
}

export interface RetryDecisionInput {
  completedAttempt: number;
  failure: RetryableFailure;
  responseBytesReceived: number;
  idempotencyKey?: string | null;
  providerIdempotencyContract?: ProviderIdempotencyContract;
  retryAfter?: string | null;
  startedAtMs: number;
  deadlineMs: number;
  nowMs?: number;
  policy?: RetryPolicyInput;
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: "attempt_cap" | "not_retryable" | "unsafe_post" | "deadline" };

/** Applies retry eligibility, idempotency safety, bounded delay, and the total deadline together. */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const policy = normalizeRetryPolicy(input.policy);
  if (input.completedAttempt >= policy.maxAttempts) return { retry: false, reason: "attempt_cap" };
  if (!isRetryableFailure(input.failure, policy.retryOn)) return { retry: false, reason: "not_retryable" };
  if (!isSafePostRetry(input.responseBytesReceived, input.idempotencyKey, input.providerIdempotencyContract)) return { retry: false, reason: "unsafe_post" };

  const nowMs = input.nowMs ?? Date.now();
  const delayMs = retryDelayMs(input.completedAttempt, policy, input.retryAfter, nowMs);
  if (remainingDeadlineMs(input.startedAtMs, input.deadlineMs, nowMs) <= delayMs) {
    return { retry: false, reason: "deadline" };
  }
  return { retry: true, delayMs };
}

/**
 * Stable target identity across dispatch concerns. New snapshots carry the
 * persisted target id; legacy snapshots are kept distinct with an unambiguous
 * encoded composite fallback.
 */
export function snapshotTargetIdentity(target: SnapshotTarget): string {
  if (target.targetId && target.targetId.trim().length > 0) {
    return `target:${target.targetId}`;
  }
  return `legacy:${JSON.stringify([target.offeringId, target.credentialId])}`;
}

/**
 * Produces a deterministic failover sequence. The already selected target is
 * first, then remaining healthy targets in the supplied health/order sequence;
 * duplicate target identities are discarded.
 */
export function orderTargetAttempts(
  selected: SnapshotTarget,
  remainingHealthy: readonly SnapshotTarget[],
): SnapshotTarget[] {
  const seen = new Set<string>();
  const ordered: SnapshotTarget[] = [];
  for (const target of [selected, ...remainingHealthy]) {
    const identity = snapshotTargetIdentity(target);
    if (!seen.has(identity)) {
      seen.add(identity);
      ordered.push(target);
    }
  }
  return ordered;
}
