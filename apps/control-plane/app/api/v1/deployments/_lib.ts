import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { ManifoldError } from "@/lib/http";

export const TRUSTED_HOST_INVARIANT =
  "The profile is bound to this trusted hostname. No header, query parameter, token claim, or request body can select or upgrade the profile.";

export const INSTALLATION_EDITIONS = ["vercel", "cloudflare", "compose"] as const;
export const PROFILE_MODES = ["public_app", "enterprise_egress"] as const;
export const NETWORK_EXPOSURES = ["public", "vpc", "mtls"] as const;

function validation(message: string, path: string): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message,
    reasonCodes: [],
    details: { issues: [{ path, message }] },
  });
}

export function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    validation(`unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, unknown[0]!);
  }
}

export function enumField<T extends string>(
  body: Record<string, unknown>,
  field: string,
  values: readonly T[],
  fallback?: T,
): T {
  const value = body[field] ?? fallback;
  if (typeof value !== "string" || !values.includes(value as T)) {
    validation(`${field} must be one of ${values.join(", ")}`, field);
  }
  return value as T;
}

export function optionalObject(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    validation(`${field} must be a JSON object`, field);
  }
  return value as Record<string, unknown>;
}

export function optionalStringList(
  body: Record<string, unknown>,
  field: string,
): string[] | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    validation(`${field} must be an array of non-empty strings`, field);
  }
  return [...new Set(value as string[])];
}

export function canonicalHostname(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    validation("hostname is required and must be a non-empty string", "hostname");
  }
  if (value !== value.trim() || value.includes("://") || /[/\\@:#?*]/u.test(value)) {
    validation("hostname must be a bare DNS hostname without a scheme, port, path, wildcard, or credentials", "hostname");
  }
  const withoutTrailingDot = value.endsWith(".") ? value.slice(0, -1) : value;
  const hostname = domainToASCII(withoutTrailingDot).toLowerCase();
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname === "localhost" ||
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname.split(".").some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    validation("hostname must be a valid, fully qualified DNS hostname", "hostname");
  }
  return hostname;
}

function requireConfigString(config: Record<string, unknown>, field: string, path: string): string {
  const value = config[field];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    validation(`${path}.${field} must be a non-empty string`, `${path}.${field}`);
  }
  return value;
}

function requireHttpsUrl(config: Record<string, unknown>, field: string, path: string): string {
  const value = requireConfigString(config, field, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    validation(`${path}.${field} must be a valid HTTPS URL`, `${path}.${field}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    validation(`${path}.${field} must be a credential-free HTTPS URL`, `${path}.${field}`);
  }
  return value;
}

function requirePublicHttpsUrl(config: Record<string, unknown>, field: string, path: string): string {
  const value = requireHttpsUrl(config, field, path);
  const url = new URL(value);
  if (url.port || isIP(url.hostname) !== 0 || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    validation(`${path}.${field} must use a public HTTPS hostname on port 443`, `${path}.${field}`);
  }
  return value;
}

export function validateAuthConfig(
  mode: (typeof PROFILE_MODES)[number],
  value: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!value) validation("authConfig is required", "authConfig");

  if (mode === "public_app") {
    assertOnlyFields(value, ["audience", "tokenTtlSeconds"]);
    const audience = requireConfigString(value, "audience", "authConfig");
    const ttl = value.tokenTtlSeconds ?? 900;
    if (!Number.isInteger(ttl) || (ttl as number) < 60 || (ttl as number) > 3600) {
      validation("authConfig.tokenTtlSeconds must be an integer from 60 through 3600", "authConfig.tokenTtlSeconds");
    }
    return { audience, tokenTtlSeconds: ttl };
  }

  const method = enumField(value, "method", ["oidc", "saml", "workload_identity"] as const);
  if (method === "saml") {
    assertOnlyFields(value, ["method", "metadataUrl", "audience"]);
    return {
      method,
      metadataUrl: requireHttpsUrl(value, "metadataUrl", "authConfig"),
      audience: requireConfigString(value, "audience", "authConfig"),
    };
  }
  assertOnlyFields(value, ["method", "issuer", "audience"]);
  return {
    method,
    issuer: requireHttpsUrl(value, "issuer", "authConfig"),
    audience: requireConfigString(value, "audience", "authConfig"),
  };
}

function validCidr(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  const version = isIP(address ?? "");
  if (!version || extra !== undefined || prefix === undefined || !/^\d+$/u.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

export function validateNetworkConfig(
  exposure: (typeof NETWORK_EXPOSURES)[number],
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (exposure === "public") {
    if (value && Object.keys(value).length > 0) {
      validation("networkConfig must be omitted for public exposure", "networkConfig");
    }
    return null;
  }
  if (!value) validation(`networkConfig is required for ${exposure} exposure`, "networkConfig");

  if (exposure === "vpc") {
    assertOnlyFields(value, ["allowedCidrs"]);
    const allowedCidrs = optionalStringList(value, "allowedCidrs");
    if (!allowedCidrs?.length || allowedCidrs.some((cidr) => !validCidr(cidr))) {
      validation("networkConfig.allowedCidrs must contain valid IPv4 or IPv6 CIDRs", "networkConfig.allowedCidrs");
    }
    return { allowedCidrs };
  }

  assertOnlyFields(value, ["trustAnchors"]);
  const trustAnchors = optionalStringList(value, "trustAnchors");
  if (!trustAnchors?.length) {
    validation("networkConfig.trustAnchors must contain at least one trust anchor", "networkConfig.trustAnchors");
  }
  return { trustAnchors };
}

export function decodePublicKey(value: unknown, path = "publicKey"): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    validation(`${path} must be base64-encoded key bytes`, path);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 32 || decoded.length > 1024) {
    validation(`${path} must decode to between 32 and 1024 bytes`, path);
  }
  return decoded;
}

export function validateWorkloadIdentity(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  assertOnlyFields(value, ["issuer", "jwksUrl", "audience", "subject"]);
  return {
    issuer: requirePublicHttpsUrl(value, "issuer", "workloadIdentity"),
    jwksUrl: requirePublicHttpsUrl(value, "jwksUrl", "workloadIdentity"),
    audience: requireConfigString(value, "audience", "workloadIdentity"),
    subject: requireConfigString(value, "subject", "workloadIdentity"),
  };
}

export function isHostnameUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  const constraint = e.constraint_name ?? e.constraint;
  return e.code === "23505" && (constraint === "ingress_host_global_uq" || constraint === "ingress_host_uq");
}

export function hostnameTaken(hostname: string): ManifoldError {
  return new ManifoldError({
    status: 409,
    code: "HOSTNAME_TAKEN" as never,
    message: "hostname is already bound to an ingress profile",
    reasonCodes: ["HOSTNAME_TAKEN"],
    details: { hostname },
  });
}

export function profilePublished(snapshot: unknown, hostname: string, profileId: string): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const profiles = (snapshot as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return false;
  const candidate = (profiles as Record<string, unknown>)[hostname];
  return !!candidate && typeof candidate === "object" &&
    (candidate as { id?: unknown }).id === profileId;
}
