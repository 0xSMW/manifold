// @manifold/gateway-core — runtime-agnostic gateway request pipeline (SPEC §4.3, §8.1).
// ZERO platform imports: no next, no @vercel/*, no @cloudflare/*, no node:*. All platform
// touchpoints arrive by dependency injection through @manifold/ports (§4.2, §4.4).
export { handleRequest, type GatewayContext } from "./handleRequest.js";
export {
  type DistributedAdmission,
  type DistributedAdmissionDecision,
  type DistributedAdmissionDenied,
  type DistributedAdmissionGrant,
  type DistributedAdmissionInput,
} from "./distributedAdmission.js";
export { enforceRequest, type EnforceArgs, type EnforceResult } from "./enforce.js";
export { resolveProfile, normalizeHost, type ResolvedProfile } from "./resolveProfile.js";
export { authenticate, presentedKey, type AuthResult } from "./authenticate.js";
export { resolveRoute, routeKey } from "./resolveRoute.js";
export { selectTarget } from "./selectTarget.js";
export { ssrfCheck, isPrivateIp, schemeAllowed, STRICT_SSRF, type SsrfPolicy, type SsrfResult } from "./ssrf.js";
export { headerAllowlist, sanitizeResponseHeaders } from "./headers.js";
export { LocalRateLimiter, type RateLimitDecision, type RateLimitInput } from "./rateLimit.js";
export {
  LocalConcurrencyLimiter,
  limitRequestBody,
  type ConcurrencyDecision,
  type ConcurrencyInput,
  type RequestBodyLimitDecision,
} from "./runtimeLimits.js";
export {
  LocalCircuitBreaker,
  isTransientCircuitFailure,
  type CircuitBreakerSnapshot,
  type CircuitDecision,
  type CircuitFailure,
  type CircuitTargetInput,
} from "./circuitBreaker.js";
export {
  InMemoryTelemetry,
  noopTelemetry,
  startRequestTelemetry,
  type Telemetry,
  type TelemetrySpan,
  type GatewayLog,
  type GatewayMetric,
  type ProviderAttemptEnd,
  type RequestSpanEnd,
} from "./telemetry.js";
export {
  errorResponse,
  shapeForCode,
  type OpenAiErrorBody,
  type ErrorShape,
} from "./errors.js";
export {
  normalizeProviderErrorResponse,
  type NormalizedProviderError,
} from "./providerErrors.js";
