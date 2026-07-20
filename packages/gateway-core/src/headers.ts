// headerAllowlist(reqHeaders) — SPEC §2.8 / §14.4 / ADR-0015: there is NO forward-all behavior.
// Only an explicit allowlist of safe request headers forwards upstream. Hop-by-hop headers and
// the inbound Authorization header NEVER forward; provider auth is injected fresh afterward.

/** Hop-by-hop headers (RFC 7230 §6.1) — connection-scoped, must never be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Safe request headers we forward upstream. Deliberately small (ADR-0015). `authorization`
 * is intentionally absent — the client's virtual key must not reach the provider; provider
 * auth is injected fresh from the decrypted credential.
 */
const FORWARD_ALLOWLIST = new Set([
  "content-type",
  "accept",
  "accept-language",
]);

/** Additional inbound headers that must be dropped even if they somehow match. */
const NEVER_FORWARD = new Set(["authorization", "host", "cookie", "content-length"]);

/**
 * Produce the upstream Headers from the inbound request, forwarding only allowlisted safe
 * headers. Provider auth is added by the caller after this returns.
 */
export function headerAllowlist(reqHeaders: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of reqHeaders.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (NEVER_FORWARD.has(lower)) continue;
    if (!FORWARD_ALLOWLIST.has(lower)) continue;
    out.set(lower, value);
  }
  return out;
}

/**
 * Strip hop-by-hop headers from an upstream RESPONSE before relaying to the client, so the
 * client sees clean end-to-end headers. Content-Length is dropped because we stream.
 */
export function sanitizeResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of upstream.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-length") continue;
    out.set(lower, value);
  }
  return out;
}
