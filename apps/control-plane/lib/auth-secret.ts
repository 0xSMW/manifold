import { createHmac, randomBytes } from "node:crypto";

export const DEVELOPMENT_AUTH_TOKEN_PEPPER = "manifold-development-auth-token-pepper-v1";

type Environment = Record<string, string | undefined>;

export function resolveAuthTokenPepper(env: Environment = process.env): string {
  const configured = env.MANIFOLD_AUTH_TOKEN_PEPPER?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error("MANIFOLD_AUTH_TOKEN_PEPPER must be set in production");
  }
  return DEVELOPMENT_AUTH_TOKEN_PEPPER;
}

/** HMAC-SHA256 for human-session/action tokens; deliberately independent from API-key peppering. */
export function hashAuthToken(token: string, env: Environment = process.env): Buffer {
  return createHmac("sha256", resolveAuthTokenPepper(env)).update(token, "utf8").digest();
}

/** Opaque, URL-safe 256-bit action token. Store only hashAuthToken(token). */
export function generateAuthActionToken(): string {
  return randomBytes(32).toString("base64url");
}
