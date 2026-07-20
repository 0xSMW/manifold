// @manifold/gateway-core — runtime-agnostic gateway request pipeline (SPEC §4.3, §8.1).
// ZERO platform imports: no next, no @vercel/*, no @cloudflare/*, no node:*. All platform
// touchpoints arrive by dependency injection through @manifold/ports (§4.2, §4.4).
export { handleRequest, type GatewayContext } from "./handleRequest.js";
export { resolveProfile, normalizeHost, type ResolvedProfile } from "./resolveProfile.js";
export { authenticate, presentedKey, type AuthResult } from "./authenticate.js";
export { resolveRoute, routeKey } from "./resolveRoute.js";
export { selectTarget } from "./selectTarget.js";
export { ssrfCheck, STRICT_SSRF, type SsrfPolicy, type SsrfResult } from "./ssrf.js";
export { headerAllowlist, sanitizeResponseHeaders } from "./headers.js";
export {
  errorResponse,
  reasonResponse,
  shapeForCode,
  type OpenAiErrorBody,
  type ErrorShape,
} from "./errors.js";
