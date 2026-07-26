import { hashAuthToken } from "@/lib/auth-secret";
import { rawSql } from "@/lib/db";
import { ManifoldError } from "@/lib/http";

/** Fixed-window global auth throttling; subject hashes prevent retention of raw emails/IPs. */
export async function chargeAuthRateLimit(kind: string, subject: string, limit: number, windowMs = 60_000): Promise<void> {
  const now = Date.now();
  const bucket = new Date(Math.floor(now / windowMs) * windowMs);
  const expires = new Date(bucket.getTime() + windowMs * 2);
  const rows = await rawSql()<{ auth_charge_rate_limit: number | null }[]>`SELECT auth_charge_rate_limit(${kind}, ${hashAuthToken(subject)}, ${bucket.toISOString()}, ${expires.toISOString()}, ${limit})`;
  if (!rows[0]?.auth_charge_rate_limit) throw new ManifoldError({ status: 429, code: "FORBIDDEN", message: "too many requests", reasonCodes: ["AUTH_RATE_LIMITED"], retryable: true });
}

/** Trust only platform-injected client-IP headers. Generic X-Forwarded-For is caller controlled. */
export function trustedClientBoundary(request: Request): string {
  for (const header of ["x-vercel-forwarded-for", "cf-connecting-ip", "fly-client-ip"]) {
    const raw = request.headers.get(header)?.trim();
    if (raw && raw.length <= 128 && /^[0-9a-fA-F:.]+$/.test(raw)) return raw.toLowerCase();
  }
  // A conservative shared bucket still constrains abuse when a deployment has no trusted proxy.
  return "unattributed";
}

export async function chargePublicAuthRateLimit(kind: string, email: string, request: Request, limit: number, windowMs: number): Promise<void> {
  await Promise.all([
    chargeAuthRateLimit(`${kind}:email`, email.trim().toLowerCase(), limit, windowMs),
    chargeAuthRateLimit(`${kind}:ip`, trustedClientBoundary(request), limit, windowMs),
  ]);
}

/** Capability completion has no stable public subject before redemption. Bound it by trusted client
 * before any Argon2 work, so a caller cannot evade the limit by rotating opaque action tokens. */
export async function chargeAuthCapabilityCompletion(kind: string, request: Request, limit = 10, windowMs = 15 * 60 * 1000): Promise<void> {
  await chargeAuthRateLimit(`${kind}:ip`, trustedClientBoundary(request), limit, windowMs);
}
