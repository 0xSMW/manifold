type Environment = Record<string, string | undefined>;

export function canonicalAuthOrigin(env: Environment = process.env): string {
  const raw = env.MANIFOLD_AUTH_ORIGIN?.trim();
  if (!raw) throw new Error("MANIFOLD_AUTH_ORIGIN must be set");

  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("MANIFOLD_AUTH_ORIGIN must be an absolute origin"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MANIFOLD_AUTH_ORIGIN must contain only an origin");
  }
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("MANIFOLD_AUTH_ORIGIN must use HTTPS in production");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MANIFOLD_AUTH_ORIGIN must use HTTP or HTTPS");
  }
  return url.origin;
}

export function isSameOriginRequest(request: Request, env: Environment = process.env): boolean {
  return request.headers.get("origin") === canonicalAuthOrigin(env);
}

export function assertSameOriginRequest(request: Request, env: Environment = process.env): void {
  if (!isSameOriginRequest(request, env)) throw new Error("Cross-origin request rejected");
}
