import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import type {
  GatewayLog,
  GatewayMetric,
  ProviderAttemptEnd,
  RequestSpanEnd,
  Telemetry,
  TelemetrySpan,
} from "@manifold/gateway-core";
import { registerOTel } from "@vercel/otel";

const SERVICE_NAME = "manifold-gateway";
const tracer = trace.getTracer(SERVICE_NAME);
const meter = metrics.getMeter(SERVICE_NAME);
const requestDuration = meter.createHistogram("gateway.request.duration_ms", { unit: "ms" });
const attemptDuration = meter.createHistogram("gateway.provider_attempt.duration_ms", { unit: "ms" });
const requestCount = meter.createCounter("gateway.request.count", { unit: "1" });
const attemptCount = meter.createCounter("gateway.provider_attempt.count", { unit: "1" });

let registered = false;
let telemetry: Telemetry | undefined;

function attributes(input: {
  installationId?: string;
  profileId?: string;
  routeId?: string;
  endpoint?: string;
  provider?: string;
  statusCode?: number;
  reason?: string;
  outcome?: string;
  retryCount?: number;
  failoverCount?: number;
  retried?: boolean;
  failedOver?: boolean;
  attempt?: number;
}): Attributes {
  return {
    ...(input.installationId ? { "manifold.installation.id": input.installationId } : {}),
    ...(input.profileId ? { "manifold.profile.id": input.profileId } : {}),
    ...(input.routeId ? { "manifold.route.id": input.routeId } : {}),
    ...(input.endpoint ? { "gen_ai.operation.name": input.endpoint } : {}),
    ...(input.provider ? { "gen_ai.provider.name": input.provider } : {}),
    ...(input.statusCode !== undefined ? { "http.response.status_code": input.statusCode } : {}),
    ...(input.reason ? { "manifold.reason": input.reason } : {}),
    ...(input.outcome ? { "manifold.outcome": input.outcome } : {}),
    ...(input.retryCount !== undefined ? { "manifold.retry.count": input.retryCount } : {}),
    ...(input.failoverCount !== undefined ? { "manifold.failover.count": input.failoverCount } : {}),
    ...(input.retried !== undefined ? { "manifold.attempt.retried": input.retried } : {}),
    ...(input.failedOver !== undefined ? { "manifold.attempt.failed_over": input.failedOver } : {}),
    ...(input.attempt !== undefined ? { "manifold.attempt.number": input.attempt } : {}),
  };
}

class OpenTelemetrySpan implements TelemetrySpan {
  readonly span: Span;

  constructor(span: Span) {
    this.span = span;
  }

  end(input: RequestSpanEnd | ProviderAttemptEnd): void {
    this.span.setAttributes(attributes(input));
    this.span.setStatus({
      code: input.outcome === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    this.span.end();
  }
}

class VercelTelemetry implements Telemetry {
  startRequest(input: Parameters<Telemetry["startRequest"]>[0]): TelemetrySpan {
    return new OpenTelemetrySpan(tracer.startSpan("manifold.gateway.request", {
      attributes: attributes(input),
    }));
  }

  startProviderAttempt(
    parent: TelemetrySpan,
    input: Parameters<Telemetry["startProviderAttempt"]>[1],
  ): TelemetrySpan {
    const parentContext = parent instanceof OpenTelemetrySpan
      ? trace.setSpan(context.active(), parent.span)
      : context.active();
    return new OpenTelemetrySpan(tracer.startSpan(
      "manifold.gateway.provider_attempt",
      { attributes: attributes(input) },
      parentContext,
    ));
  }

  recordMetric(metric: GatewayMetric): void {
    const labels = attributes(metric);
    switch (metric.name) {
      case "gateway.request.duration_ms":
        requestDuration.record(metric.value, labels);
        break;
      case "gateway.provider_attempt.duration_ms":
        attemptDuration.record(metric.value, labels);
        break;
      case "gateway.request.count":
        requestCount.add(metric.value, labels);
        break;
      case "gateway.provider_attempt.count":
        attemptCount.add(metric.value, labels);
        break;
    }
  }

  log(entry: GatewayLog): void {
    // Vercel runtime logs are correlated with the invocation trace and can be exported through
    // a Log Drain. The core sanitizer guarantees this object has no prompt/key/credential fields.
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: entry.outcome === "error" ? "error" : "info",
      service: SERVICE_NAME,
      ...entry,
    }));
  }
}

export function getVercelTelemetry(): Telemetry {
  if (!registered) {
    registerOTel({ serviceName: SERVICE_NAME });
    registered = true;
  }
  telemetry ??= new VercelTelemetry();
  return telemetry;
}
