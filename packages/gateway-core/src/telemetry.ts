/**
 * Vendor-neutral gateway telemetry vocabulary.  This deliberately accepts a
 * small, low-cardinality attribute set: request material, credentials, URLs,
 * and provider response bodies have no representable field here.
 */

export type GatewayEndpoint = "chat" | "responses" | "embeddings" | "models" | "unknown";

export type TelemetryOutcome = "success" | "error" | "cancelled" | "rejected";

export type TelemetryReason =
  | "provider_error"
  | "network_error"
  | "timeout"
  | "budget_denied"
  | "rate_limited"
  | "stream_aborted"
  | "internal_error"
  | "retry"
  | "failover";

/** Fields allowed on every exported telemetry record. */
export interface SafeTelemetryAttributes {
  readonly installationId?: string;
  readonly profileId?: string;
  readonly routeId?: string;
  readonly endpoint?: GatewayEndpoint;
  readonly provider?: string;
  readonly statusCode?: number;
  readonly reason?: TelemetryReason;
}

export interface RequestSpanStart extends SafeTelemetryAttributes {}

export interface RequestSpanEnd extends SafeTelemetryAttributes {
  readonly outcome: TelemetryOutcome;
  readonly retryCount?: number;
  readonly failoverCount?: number;
}

export interface ProviderAttemptStart extends SafeTelemetryAttributes {
  readonly attempt: number;
}

export interface ProviderAttemptEnd extends SafeTelemetryAttributes {
  readonly outcome: TelemetryOutcome;
  readonly retried?: boolean;
  readonly failedOver?: boolean;
}

export type GatewayMetricName =
  | "gateway.request.duration_ms"
  | "gateway.provider_attempt.duration_ms"
  | "gateway.request.count"
  | "gateway.provider_attempt.count";

export interface GatewayMetric extends SafeTelemetryAttributes {
  readonly name: GatewayMetricName;
  readonly value: number;
}

export type GatewayLogEvent = "request.finished" | "provider_attempt.finished";

export interface GatewayLog extends SafeTelemetryAttributes {
  readonly event: GatewayLogEvent;
  readonly outcome: TelemetryOutcome;
  readonly retryCount?: number;
  readonly failoverCount?: number;
}

/** A tracing provider may map this directly to an OpenTelemetry Span. */
export interface TelemetrySpan {
  end(attributes: RequestSpanEnd | ProviderAttemptEnd): void;
}

/**
 * Deliberately small port: adapters can bridge it to OpenTelemetry, logs, and
 * metrics without coupling gateway-core to any SDK.
 */
export interface Telemetry {
  startRequest(attributes: RequestSpanStart): TelemetrySpan;
  startProviderAttempt(parent: TelemetrySpan, attributes: ProviderAttemptStart): TelemetrySpan;
  recordMetric(metric: GatewayMetric): void;
  log(entry: GatewayLog): void;
}

export const noopTelemetry: Telemetry = Object.freeze({
  startRequest: () => noopSpan,
  startProviderAttempt: () => noopSpan,
  recordMetric: () => undefined,
  log: () => undefined,
});

const noopSpan: TelemetrySpan = Object.freeze({ end: () => undefined });

export interface RecordedSpan {
  readonly kind: "request" | "provider_attempt";
  readonly parent?: RecordedSpan;
  readonly start: SafeTelemetryAttributes & { readonly attempt?: number };
  end?: SafeTelemetryAttributes & {
    readonly outcome: TelemetryOutcome;
    readonly retryCount?: number;
    readonly failoverCount?: number;
    readonly retried?: boolean;
    readonly failedOver?: boolean;
  };
  endCount: number;
}

/** In-process recorder for conformance tests and adapter tests. */
export class InMemoryTelemetry implements Telemetry {
  readonly spans: RecordedSpan[] = [];
  readonly metrics: GatewayMetric[] = [];
  readonly logs: GatewayLog[] = [];

  startRequest(attributes: RequestSpanStart): TelemetrySpan {
    return this.start("request", undefined, attributes);
  }

  startProviderAttempt(parent: TelemetrySpan, attributes: ProviderAttemptStart): TelemetrySpan {
    return this.start("provider_attempt", parent, attributes);
  }

  recordMetric(metric: GatewayMetric): void {
    this.metrics.push(sanitizeMetric(metric));
  }

  log(entry: GatewayLog): void {
    this.logs.push(sanitizeLog(entry));
  }

  private start(kind: RecordedSpan["kind"], parent: TelemetrySpan | undefined, attributes: RequestSpanStart | ProviderAttemptStart): TelemetrySpan {
    const parentRecorded = parent instanceof RecordedTelemetrySpan ? parent.recorded : undefined;
    const recorded: RecordedSpan = {
      kind,
      ...(parentRecorded ? { parent: parentRecorded } : {}),
      start: kind === "provider_attempt"
        ? { ...sanitizeAttributes(attributes), attempt: (attributes as ProviderAttemptStart).attempt }
        : sanitizeAttributes(attributes),
      endCount: 0,
    };
    this.spans.push(recorded);
    return new RecordedTelemetrySpan(recorded);
  }
}

class RecordedTelemetrySpan implements TelemetrySpan {
  readonly recorded: RecordedSpan;

  constructor(recorded: RecordedSpan) {
    this.recorded = recorded;
  }

  end(attributes: RequestSpanEnd | ProviderAttemptEnd): void {
    if (this.recorded.end) return;
    this.recorded.endCount += 1;
    this.recorded.end = sanitizeSpanEnd(attributes);
  }
}

export interface RequestTelemetryLifecycle {
  startAttempt(attributes: ProviderAttemptStart): ProviderAttemptTelemetryLifecycle;
  end(attributes: RequestSpanEnd): void;
}

export interface ProviderAttemptTelemetryLifecycle {
  end(attributes: ProviderAttemptEnd): void;
}

/**
 * Starts one request span and derives bounded duration/count telemetry when it
 * ends. Both lifecycle end methods are idempotent, which makes finally blocks
 * safe in retry and streaming paths.
 */
export function startRequestTelemetry(
  telemetry: Telemetry,
  attributes: RequestSpanStart,
  now: () => number = Date.now,
): RequestTelemetryLifecycle {
  const requestStart = now();
  const requestSpan = telemetry.startRequest(sanitizeAttributes(attributes));
  let requestEnded = false;

  return {
    startAttempt(attempt): ProviderAttemptTelemetryLifecycle {
      const attemptStart = now();
      const span = telemetry.startProviderAttempt(requestSpan, sanitizeAttemptStart(attempt));
      let ended = false;
      return {
        end(end): void {
          if (ended) return;
          ended = true;
          const safe = sanitizeAttemptEnd(end);
          span.end(safe);
          telemetry.recordMetric({
            name: "gateway.provider_attempt.duration_ms",
            value: durationMs(attemptStart, now()),
            ...safe,
          });
          telemetry.recordMetric({ name: "gateway.provider_attempt.count", value: 1, ...safe });
          telemetry.log({ event: "provider_attempt.finished", ...safe });
        },
      };
    },
    end(end): void {
      if (requestEnded) return;
      requestEnded = true;
      const safe = sanitizeRequestEnd(end);
      requestSpan.end(safe);
      telemetry.recordMetric({
        name: "gateway.request.duration_ms",
        value: durationMs(requestStart, now()),
        ...safe,
      });
      telemetry.recordMetric({ name: "gateway.request.count", value: 1, ...safe });
      telemetry.log({ event: "request.finished", ...safe });
    },
  };
}

function durationMs(start: number, end: number): number {
  return Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function sanitizeMetric(metric: GatewayMetric): GatewayMetric {
  return { name: metric.name, value: Number.isFinite(metric.value) ? metric.value : 0, ...sanitizeAttributes(metric) };
}

function sanitizeLog(entry: GatewayLog): GatewayLog {
  return {
    event: entry.event,
    outcome: entry.outcome,
    ...sanitizeAttributes(entry),
    ...optionalCount("retryCount", entry.retryCount),
    ...optionalCount("failoverCount", entry.failoverCount),
  };
}

function sanitizeSpanEnd(attributes: RequestSpanEnd | ProviderAttemptEnd): RecordedSpan["end"] {
  return {
    outcome: attributes.outcome,
    ...sanitizeAttributes(attributes),
    ...optionalCount("retryCount", (attributes as RequestSpanEnd).retryCount),
    ...optionalCount("failoverCount", (attributes as RequestSpanEnd).failoverCount),
    ...optionalBoolean("retried", (attributes as ProviderAttemptEnd).retried),
    ...optionalBoolean("failedOver", (attributes as ProviderAttemptEnd).failedOver),
  };
}

function sanitizeRequestEnd(attributes: RequestSpanEnd): RequestSpanEnd {
  return {
    outcome: attributes.outcome,
    ...sanitizeAttributes(attributes),
    ...optionalCount("retryCount", attributes.retryCount),
    ...optionalCount("failoverCount", attributes.failoverCount),
  };
}

function sanitizeAttemptStart(attributes: ProviderAttemptStart): ProviderAttemptStart {
  return { ...sanitizeAttributes(attributes), attempt: safeCount(attributes.attempt) };
}

function sanitizeAttemptEnd(attributes: ProviderAttemptEnd): ProviderAttemptEnd {
  return {
    outcome: attributes.outcome,
    ...sanitizeAttributes(attributes),
    ...optionalBoolean("retried", attributes.retried),
    ...optionalBoolean("failedOver", attributes.failedOver),
  };
}

function sanitizeAttributes(attributes: SafeTelemetryAttributes): SafeTelemetryAttributes {
  return {
    ...optionalIdentifier("installationId", attributes.installationId),
    ...optionalIdentifier("profileId", attributes.profileId),
    ...optionalIdentifier("routeId", attributes.routeId),
    ...(attributes.endpoint ? { endpoint: attributes.endpoint } : {}),
    ...optionalIdentifier("provider", attributes.provider),
    ...optionalStatus(attributes.statusCode),
    ...(attributes.reason ? { reason: attributes.reason } : {}),
  };
}

function optionalIdentifier<Key extends "installationId" | "profileId" | "routeId" | "provider">(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return safeIdentifier(value) ? { [key]: value } as Partial<Record<Key, string>> : {};
}

function safeIdentifier(value: string | undefined): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    && !/(?:api[_-]?key|token|secret|password|authorization|bearer|https?:\/\/|sk-[a-z0-9])/i.test(value);
}

function optionalStatus(value: number | undefined): Partial<Pick<SafeTelemetryAttributes, "statusCode">> {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? { statusCode: value } : {};
}

function safeCount(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
}

function optionalCount<Key extends "retryCount" | "failoverCount">(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return typeof value === "number" ? { [key]: safeCount(value) } as Partial<Record<Key, number>> : {};
}

function optionalBoolean<Key extends "retried" | "failedOver">(key: Key, value: boolean | undefined): Partial<Record<Key, boolean>> {
  return typeof value === "boolean" ? { [key]: value } as Partial<Record<Key, boolean>> : {};
}
